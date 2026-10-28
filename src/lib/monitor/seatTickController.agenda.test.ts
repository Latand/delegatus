import { expect, spyOn, test, fs, path, spawn, Database, SANDBOX, SESSIONS, SEAT_TICK_NO_SELF_SCHEDULE, reconcileSeatTick, runSeatTickCheck, SEAT_TICK_WAKE_UNRESOLVED_REF, startSeatTick, stopSeatTick, writeDrain, drainFile, releaseDrain, DEFAULT_SEAT_TICK_POLICY, defaultSeatTickSettings, readSeatTickState, writeSeatTickState, appendSeatTickRecord, readSeatTickRecords, SeatTickAccounting, outcomeIdentity, FileRuntimeEventStore, statePath, setAgentRegistryForTests, emptyLaunchProfile, sessionKeyFromTranscript, ORCHESTRATOR_SHIPPED_CLOCK_OPENING, ORCHESTRATOR_SEAT_TICK_CONTRACT, ORCHESTRATOR_SYSTEM_PROMPT, ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE, emptySeatTickState, PROJECT, CONVERSATION, SUCCESSOR, NOW, MINUTE, harness, OVERDUE, outstandingWake, OPEN_LANE, terminalEvent, FINISHED_LANE, standingGap, MONITOR_PROMPT, PROMPT_HEADING, seatTickNoteRevisionForTest, promptSettings, LEDGER_NOTE, busyBoard, CURRENT_SEAT, REPLACEMENT_PROMPT, reservationLayer, HELD, heldWake, nextCheck, childFixture, childRig, ago, recordedWake } from "./seatTickController.fixture";
import type { SeatTickRunRecord, AgentLivenessRecord, ConversationMessage } from "./seatTickController.fixture";

function budgetLanes(long = false, count = 20) {
  return Array.from({ length: count }, (_, n) => ({
    id: `lane${String(n).padStart(4, "0")}`,
    title: long ? `Exporter ${n} ${"title ".repeat(10)}`.slice(0, 48) : `Exporter ${n}`,
    reason: long ? `decision: ${"build stopped ".repeat(5)}`.slice(0, 48) : "decision: build stopped",
    sinceMs: NOW - (120 - n) * MINUTE,
  }));
}

function installBudgetLanes(rig: ReturnType<typeof harness>, long = false) {
  const lanes = budgetLanes(long);
  rig.deps.sources!.workerAsks = async () => lanes.map(lane => ({ id: lane.id,
    key: `lane:${lane.id}:decision`, label: `${lane.title}: ${lane.reason}`,
    sinceMs: lane.sinceMs, seatOwnedLane: lane }));
  return lanes;
}

for (const turboEnabled of [false, true]) for (const shipped of [false, true]) {
test(`a configured autonomy wake${turboEnabled ? " with Turbo" : ""} still delivers twenty parked seat lanes to a ${shipped ? "shipped" : "bespoke"} seat`, async () => {
  const settings = { ...defaultSeatTickSettings(PROJECT), reason: "Check failed builds. ".repeat(25).slice(0, 500),
    monitorPrompt: "Inspect the build and review queues. ".repeat(300).slice(0, 7_622),
    autonomy: { enabled: true, startedAt: new Date(NOW).toISOString(), until: new Date(NOW + 8 * 60 * MINUTE).toISOString(),
      endedAt: null, endReason: null, updatedAt: new Date(NOW).toISOString(),
      setBy: { kind: "gateway" as const, project: null, conversationId: null, seatEpoch: null }, why: null, decisions: [] } };
  const rig = harness({ state: OVERDUE, settings: { ...settings,
    turbo: turboEnabled ? { ...settings.autonomy,
      plan: [{ accountId: "acct-priority", label: "Priority", plan: "pro", tiers: { "gpt-6.1-sol": "priority" as const }, hadCredits: false }],
      credits: { approved: false, accounts: [], approvedAt: null, withdrawnAt: null, withdrawnBy: null, withdrawnWhy: null },
      switches: [] } : null },
    seat: { conversationId: CONVERSATION, seatEpoch: 7, path: null,
      mandate: shipped ? ORCHESTRATOR_SYSTEM_PROMPT : "Coordinate this project's builds and reviews.", promptVersion: shipped ? 55 : null } });
  const lanes = installBudgetLanes(rig);
  expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).toBe("wake");
  expect(rig.sent).toHaveLength(1);
  const text = rig.sent[0]!.text;
  expect(text.length).toBeLessThanOrEqual(4_000);
  expect(text).toContain(settings.reason);
  for (const lane of lanes) {
    const row = text.split("\n").find(line => line.startsWith(`- ${lane.id}`))!;
    expect(row).toContain(lane.title);
    expect(row).toContain(lane.reason);
    const minutes = (NOW - lane.sinceMs) / MINUTE;
    expect(row).toContain(minutes === 120 ? "2h" : `1h ${minutes - 60}m`);
  }
  const shown = rig.written.at(-1)!.itemsShown!;
  expect(shown.length).toBeGreaterThan(0);
  const detail = text.split("\n").find(line => line.startsWith("- [ask] lane0000 — "))!;
  expect(detail === `- [ask] lane0000 — ${lanes[0]!.title}: ${lanes[0]!.reason}`
    || /… \[summary; .+ holds the full item\]$/.test(detail)).toBe(true);
});
}

test.each([42, 43])("%i routed lanes still wake when liveness spends its share", async count => {
  for (const skipped of [false, true]) {
    const settings = { ...defaultSeatTickSettings(PROJECT), reason: "Check failed builds. ".repeat(25).slice(0, 500),
      monitorPrompt: "Inspect the build and review queues. ".repeat(300).slice(0, 7_622),
      autonomy: { enabled: true, startedAt: new Date(NOW).toISOString(), until: new Date(NOW + 8 * 60 * MINUTE).toISOString(),
        endedAt: null, endReason: null, updatedAt: new Date(NOW).toISOString(),
        setBy: { kind: "gateway" as const, project: null, conversationId: null, seatEpoch: null }, why: null, decisions: [] } };
    const rig = harness({ state: OVERDUE, settings,
      seat: { conversationId: CONVERSATION, seatEpoch: 7, path: null, mandate: ORCHESTRATOR_SYSTEM_PROMPT, promptVersion: 55 } });
    let now = 0, next = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    Object.assign(rig.deps, { workBudgetMs: 800, workClock: () => now, workScheduler: {
      setTimeout: (run: () => void, delay: number) => { const id = ++next; timers.set(id, { at: now + delay, run }); return id; },
      clearTimeout: (id: unknown) => { timers.delete(id as number); },
    } });
    let reads = 0;
    rig.deps.sources!.liveness = async () => {
      if (skipped && ++reads === 1) {
        now += 100;
        for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); }
      }
      return [];
    };
    const lanes = budgetLanes(true, count);
    rig.deps.sources!.workerAsks = async () => lanes.map(lane => ({ id: lane.id,
      key: `lane:${lane.id}:decision`, label: `${lane.title}: ${lane.reason}`, sinceMs: lane.sinceMs, seatOwnedLane: lane }));
    const result = await runSeatTickCheck(PROJECT, rig.deps);
    expect(result).toMatchObject({ verdict: "wake", delivery: { outcome: "delivered" } });
    expect(rig.sent).toHaveLength(1);
    const text = rig.sent[0]!.text;
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).toContain(settings.reason);
    for (const lane of lanes) {
      const row = text.split("\n").find(line => line.startsWith(`- ${lane.id}|`));
      expect(row).toContain("decision:");
      expect(row).toMatch(/decision: build stoppe(?:d|…)/);
      const minutes = (NOW - lane.sinceMs) / MINUTE;
      expect(row).toContain(minutes === 120 ? "2h" : `1h ${minutes - 60}m`);
    }
    const detail = text.split("\n").find(line => line.startsWith("- [ask] lane0000 — "))!;
    expect(detail === `- [ask] lane0000 — ${lanes[0]!.title}: ${lanes[0]!.reason}`
      || /… \[summary; .+ holds the full item\]$/.test(detail)).toBe(true);
    expect(rig.written.at(-1)!.itemsShown!.length).toBeGreaterThan(0);
    if (skipped) expect(text).toMatch(/skipped.*liveness/i);
    expect(now).toBe(skipped ? 100 : 0);
    expect(timers.size).toBe(0);
  }
});

test("a full roster with unavailable sources makes detail progress and then respects cadence", async () => {
  const rig = harness({ state: OVERDUE, pullRequestsUnavailable: "command-failed",
    seat: { conversationId: CONVERSATION, seatEpoch: 7, path: null, mandate: ORCHESTRATOR_SYSTEM_PROMPT, promptVersion: 55 },
    settings: { ...defaultSeatTickSettings(PROJECT), wakeIntervalMinutes: 60, reason: "Inspect failed work. ".repeat(24).slice(0, 480) } });
  const lanes = installBudgetLanes(rig, true);
  const registry = rig.deps.sources!.registry();
  registry.pageSeatChildren = () => { throw new Error("registry-unreadable"); };
  rig.deps.sources!.registry = () => registry;
  let now = NOW;
  rig.deps.sources!.now = () => now;
  for (let minute = 0; minute < 24; minute++) {
    now = NOW + minute * MINUTE;
    const before = rig.written.at(-1)?.itemsShown?.length ?? 0;
    const record = await runSeatTickCheck(PROJECT, rig.deps);
    if (record?.verdict !== "wake") {
      expect(before).toBe(20);
      continue;
    }
    const text = rig.sent.at(-1)!.text;
    expect(text.length).toBeLessThanOrEqual(4_000);
    for (const lane of lanes) expect(text.split("\n").some(line => line.startsWith(`- ${lane.id}`))).toBe(true);
    expect(rig.written.at(-1)!.itemsShown!.length).toBeGreaterThan(before);
  }
  expect(rig.written.at(-1)!.itemsShown).toHaveLength(20);
  const sent = rig.sent.length;
  expect(sent).toBeLessThanOrEqual(20);
  now = NOW + 84 * MINUTE;
  expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).toBe("wake");
  expect(rig.sent).toHaveLength(sent + 1);
});

test("bounded roster detail drains oldest first across fresh SQLite readers", async () => {
  const { gatherSeatTickInput } = await import("./seatTickSources");
  const rig = harness({ state: OVERDUE, pullRequestsUnavailable: "command-failed",
    seat: { conversationId: CONVERSATION, seatEpoch: 7, path: null, mandate: ORCHESTRATOR_SYSTEM_PROMPT, promptVersion: 55 },
    settings: { ...defaultSeatTickSettings(PROJECT), reason: "Inspect failed work. ".repeat(24).slice(0, 480) } });
  const lanes = installBudgetLanes(rig, true);
  const registry = rig.deps.sources!.registry();
  registry.pageSeatChildren = () => { throw new Error("registry-unreadable"); };
  rig.deps.sources!.registry = () => registry;
  const input = await gatherSeatTickInput(PROJECT, rig.deps.readState!(PROJECT), DEFAULT_SEAT_TICK_POLICY, rig.deps.sources!);
  const root = fs.mkdtempSync(path.join(SANDBOX, "roster-readers-"));
  const file = path.join(root, "input.json");
  const stateFile = path.join(root, "seat-tick.json");
  fs.writeFileSync(file, JSON.stringify(input));
  writeSeatTickState(PROJECT, { ...input.state, accounting: undefined }, stateFile);
  const source = `
    import fs from "node:fs";
    import { seatTickDecision, seatTickWakeCommitPlan, seatTickWakeCommit } from ${JSON.stringify(path.join(import.meta.dir, "seatTick.ts"))};
    import { seatTickWakePayload } from ${JSON.stringify(path.join(import.meta.dir, "report.ts"))};
    import { readSeatTickState, writeSeatTickState } from ${JSON.stringify(path.join(import.meta.dir, "seatTickState.ts"))};
    const [file, stateFile, time] = process.argv.slice(1);
    const input = JSON.parse(fs.readFileSync(file, "utf8"));
    input.now = Number(time); input.state = readSeatTickState(input.project, stateFile);
    const decision = seatTickDecision(input), verdict = decision.verdict;
    let state = decision.state, text = "", ids = [];
    if (verdict.kind === "wake") {
      const payload = seatTickWakePayload({ ...input, ...verdict, operatorInstructions: input.settings.reason,
        mandateCarriesContract: input.seat.mandateCarriesTickContract, snapshotAt: new Date(input.now).toISOString() });
      text = payload.text; verdict.items = payload.items;
      const commit = seatTickWakeCommitPlan(verdict, { fingerprint: input.changeFingerprint,
        eventsThrough: input.state.eventsThrough ?? 0, wakeIntervalMs: input.settings.wakeIntervalMs, frozenText: text });
      ids = payload.items.filter(item => commit.itemsShown.includes(item.itemVersion)).map(item => item.id);
      state = seatTickWakeCommit({ ...state, outstandingWake: { text, commit, conversationId: input.seat.conversationId,
        seatEpoch: input.seat.seatEpoch, clientMessageId: "fixture-wake", operationId: null } }, commit, input.now);
    }
    writeSeatTickState(input.project, state, stateFile);
    console.log(JSON.stringify({ kind: verdict.kind, count: state.itemsShown.length, ids, text }));`;
  const run = async (minute: number) => {
    const child = Bun.spawn([process.execPath, "-e", source, file, stateFile, String(NOW + minute * MINUTE)], {
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root,
        LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout) as { kind: string; count: number; ids: string[]; text: string };
  };
  const shown: string[] = [];
  let lastWake = 0;
  for (let minute = 0; shown.length < 20 && minute < 20; minute++) {
    const result = await run(minute);
    expect(result.kind).toBe("wake");
    expect(result.count).toBeGreaterThan(shown.length);
    expect(result.text.length).toBeLessThanOrEqual(4_000);
    for (const lane of lanes) expect(result.text.split("\n").some(line => line.startsWith(`- ${lane.id}`))).toBe(true);
    shown.push(...result.ids);
    lastWake = minute;
  }
  expect(shown).toEqual(lanes.map(lane => lane.id));
  expect((await run(lastWake + 59)).kind).not.toBe("wake");
  expect((await run(lastWake + 60)).kind).toBe("wake");
});

test("the controller delivers the full seat-owned roster while detail remains capped", async () => {
  const rig = harness({ state: OVERDUE });
  const lanes = Array.from({ length: 20 }, (_, n) => ({
    id: `parked-${n}`, title: `Repair exporter ${n}`, reason: "decision: build stopped", sinceMs: NOW - (40 - n) * MINUTE,
  }));
  rig.deps.sources!.workerAsks = async () => lanes.map(lane => ({
    id: lane.id, key: `lane:${lane.id}:decision`, label: `${lane.title}: inspect the failed build and resolve it`,
    sinceMs: lane.sinceMs, seatOwnedLane: lane,
  }));
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record?.verdict).toBe("wake");
  expect(rig.sent).toHaveLength(1);
  const text = rig.sent[0]!.text;
  expect(text.length).toBeLessThanOrEqual(4_000);
  for (const lane of lanes) expect(text).toContain(`- ${lane.id} | ${lane.title} |`);
  // The roster alone never acknowledges detail that the capped agenda omitted.
  const shown = rig.written.at(-1)!.itemsShown ?? [];
  expect(shown).toHaveLength(DEFAULT_SEAT_TICK_POLICY.itemsPerWake);
});

test("the controller keeps delivering at cadence with one parked lane and no events", async () => {
  const rig = harness({ state: OVERDUE });
  let now = NOW;
  rig.deps.sources!.now = () => now;
  rig.deps.sources!.workerAsks = async () => [{ id: "parked-build", key: "lane:parked-build:decision",
    label: "Repair exporter: resolve the failed build", sinceMs: NOW - 120 * MINUTE,
    seatOwnedLane: { id: "parked-build", title: "Repair exporter", reason: "decision: build failed", sinceMs: NOW - 120 * MINUTE } }];
  for (let cycle = 0; cycle < 4; cycle++) {
    now = NOW + cycle * 60 * MINUTE;
    expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).toBe("wake");
    expect(rig.sent).toHaveLength(cycle + 1);
    expect(rig.sent.at(-1)!.text).toContain("- parked-build | Repair exporter |");
    now += 60 * MINUTE - 1;
    expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).toBe("quiet");
    expect(rig.sent).toHaveLength(cycle + 1);
  }
  rig.deps.sources!.workerAsks = async () => [];
  now = NOW + 4 * 60 * MINUTE;
  expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).not.toBe("wake");
});


test("a seat mid-turn is skipped without a send and without consuming the event cursor", async () => {
  const rig = harness({
    turn: "busy",
    seatActivity: { lifecycle: "running", reason: "host_alive_turn_active" },
    pipelines: OPEN_LANE,
    events: [terminalEvent(44)],
    state: { ...OVERDUE, eventsThrough: 12 },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "skipped", delivery: null, eventsThrough: 12 });
  expect(rig.sent).toEqual([]);
});

/* And the seat whose own host died under an open turn: the registry still says
   `busy`, so the rule this replaces would have dropped every tick forever. */
test("a busy seat the registry reports stalled is woken, which is what resumes its host", async () => {
  const rig = harness({
    turn: "busy",
    seatActivity: { lifecycle: "stalled", reason: "host_gone_turn_open" },
    pipelines: OPEN_LANE,
    state: OVERDUE,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.verdict).toBe("wake");
  expect(rig.sent).toHaveLength(1);
});

test("open work in a project whose seat was never designated raises no orchestrator card (#2170)", async () => {
  const rig = harness({ seat: null, seatEverHeld: false, tasks: [{ id: "first-task", status: "inbox" }] });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "no-seat", seatEpoch: null });
  expect(rig.cards).toEqual([]);
  expect(rig.sent).toEqual([]);
});

test("open work with nobody seated raises the orchestrator card and wakes nothing", async () => {
  const rig = harness({ seat: null, pipelines: OPEN_LANE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "no-seat", seatEpoch: null });
  expect(rig.cards).toHaveLength(1);
  expect(rig.cards[0]!.card.ref).toBe("orchestrator-unresolved");
  expect(rig.sent).toEqual([]);
});

test("a drain beginning during proposal preparation holds the fresh wake until release", async () => {
  const h = harness({});
  let maintenanceLaunches = 0;
  h.deps.maintenance = { reconcile: async () => null, launchIfDue: async () => { maintenanceLaunches++; return null; } };
  let entered!: () => void;
  let resume!: () => void;
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  h.deps.proposalIssues = async () => { entered(); await gate; return [{ number: 1, title: "New work", labels: [], updatedAt: null }]; };
  const check = runSeatTickCheck(PROJECT, h.deps);
  await preparing;
  writeDrain(drainFile(), { id: "inflight-seat", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
  try {
    resume();
    const held = await check;
    expect(h.sent).toHaveLength(0);
    expect(maintenanceLaunches).toBe(0);
    expect(held?.delivery?.outcome).toBe("update-held");
    releaseDrain(drainFile(), "inflight-seat");
    await runSeatTickCheck(PROJECT, h.deps);
    expect(h.sent).toHaveLength(1);
    expect(maintenanceLaunches).toBeGreaterThan(0);
    await runSeatTickCheck(PROJECT, h.deps);
    expect(h.sent).toHaveLength(1);
  } finally { resume(); releaseDrain(drainFile(), "inflight-seat"); }
});

test("the proactive slot delivers a proposal brief built from open issues", async () => {
  const rig = harness({});
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.verdict).toBe("proactive");
  expect(rig.sent[0]!.text).toContain("#1245 the native seat tick");
  expect(rig.written.at(-1)!.lastProposalAt).toBe(new Date(NOW).toISOString());
});

/* An empty log reads exactly like a run that never happened — the ambiguity
   this journal exists to remove — so a check that throws still leaves a line. */
test("a check that throws still leaves one journal line, naming the failure", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, { ...rig.deps, readState: () => { throw new Error("the row cannot be read"); } });
  expect(record).toMatchObject({ verdict: "error", project: PROJECT, delivery: null });
  expect(record!.detail).toContain("the check failed");
  expect(rig.journal).toHaveLength(1);
});

test("the tick is one clock in one process: a second start is refused out loud and on the record", () => {
  const refused: string[] = [];
  const journal: SeatTickRunRecord[] = [];
  const ports = {
    scheduleInterval: () => ({ unref() {} }) as never,
    sweep: async () => undefined,
    policy: DEFAULT_SEAT_TICK_POLICY,
    log: (line: string) => refused.push(line),
    appendRecord: (record: SeatTickRunRecord) => { journal.push(record); },
  };
  expect(startSeatTick(ports)).toBe(true);
  expect(startSeatTick(ports)).toBe(false);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toContain("exactly one ticker per seat");
  expect(journal).toHaveLength(1);
  expect(journal[0]).toMatchObject({ verdict: "refused" });
});

/* The refusal above only covers a second start inside ONE process, and one
   process is not one process for ever: a deploy promotes a successor beside the
   incumbent, and the predecessor keeps its armed timer. Traffic authority is
   the durable fact both of them can read, so the sweep re-asks it. */
test("a release that no longer owns traffic refuses the sweep, records it, and stops its own clock", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  let swept = 0;
  rig.deps.sources!.activeSeats = () => { swept += 1; return [PROJECT]; };
  const ports = {
    scheduleInterval: () => ({ unref() {} }) as never,
    sweep: async () => undefined,
    policy: DEFAULT_SEAT_TICK_POLICY,
    log: () => {},
    appendRecord: () => {},
  };
  expect(startSeatTick(ports)).toBe(true);

  const records = await reconcileSeatTick({ ...rig.deps, ownsTraffic: () => false });
  expect(records).toEqual([]);
  expect(swept).toBe(0);
  expect(rig.sent).toEqual([]);
  expect(rig.journal).toHaveLength(1);
  expect(rig.journal[0]).toMatchObject({ verdict: "refused", project: "", seatEpoch: null, delivery: null });
  expect(rig.journal[0]!.detail).toContain("no longer owns viewer traffic");
  /* The clock is genuinely stopped, not merely quiet: a start is accepted again
     rather than refused as a second one. */
  expect(startSeatTick(ports)).toBe(true);
});

test("the release that does own traffic sweeps every project it has an opinion about", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const records = await reconcileSeatTick({ ...rig.deps, ownsTraffic: () => true });
  expect(records.map((record) => record.project)).toEqual([PROJECT]);
  expect(records[0]!.verdict).toBe("wake");
  expect(rig.sent).toHaveLength(1);
});

/* An unauthorized sweep that crashed on its own journal would be a refusal
   nobody is left with — including the clock, which must still stop. */
test("an unwritable journal does not turn the lost-authority refusal into a crash", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const records = await reconcileSeatTick({
    ...rig.deps,
    ownsTraffic: () => false,
    appendRecord: () => { throw new Error("the journal is unwritable"); },
  });
  expect(records).toEqual([]);
  expect(rig.sent).toEqual([]);
});

test("the off switch keeps the clock unstarted and says so", () => {
  const refused: string[] = [];
  expect(startSeatTick({ policy: null, log: (line) => refused.push(line) })).toBe(false);
  expect(refused[0]).toContain("LLV_SEAT_TICK_CHECK_MINUTES=0");
});

test("automatic drain holds seat sweeps and release resumes the next sweep", async () => {
  stopSeatTick();
  let held = true;
  let fire = () => {};
  let sweeps = 0;
  const holds: string[] = [];
  const journal = path.join(SANDBOX, "timer-holds.ndjson");
  startSeatTick({ drainHeld: () => held, handoffHeld: () => false,
    scheduleInterval: (callback) => { fire = callback; return { unref() {} } as never; },
    sweep: async () => { sweeps++; }, policy: DEFAULT_SEAT_TICK_POLICY, log: () => {},
    appendRecord: record => { holds.push(record.detail!); appendSeatTickRecord(record, journal); },
  });
  fire();
  expect(sweeps).toBe(0);
  expect(holds).toHaveLength(2);
  expect(holds.every(line => line.includes("update-drain; next check"))).toBe(true);
  expect(readSeatTickRecords(10, journal).map(record => record.detail)).toEqual(holds);
  held = false;
  fire();
  await Bun.sleep(0);
  expect(sweeps).toBe(1);
  stopSeatTick();
});

test("a pass that outran its interval still checks due projects on each callback", async () => {
  let fire = () => {};
  let sweeps = 0;
  const releases: (() => void)[] = [];
  startSeatTick({
    scheduleInterval: (callback) => { fire = callback; return { unref() {} } as never; },
    sweep: () => { sweeps += 1; return new Promise<void>((resolve) => { releases.push(resolve); }); },
    policy: DEFAULT_SEAT_TICK_POLICY,
    log: () => {},
  });
  fire();
  fire();
  expect(sweeps).toBe(3);
  releases.forEach(release => release());
  await Promise.resolve();
  await Promise.resolve();
  fire();
  expect(sweeps).toBe(4);
  releases.forEach(release => release());
});

test("a wake drops a lane closed during gathering and carries the current monitor note", async () => {
  const rig = harness({ pipelines: [...OPEN_LANE, { ...OPEN_LANE[0]!, id: "current-lane" }], state: OVERDUE, settings: promptSettings() });
  const pipelines = rig.deps.sources!.pipelines;
  const liveness = rig.deps.sources!.liveness;
  rig.deps.sources!.liveness = async (request) => {
    if (!request.project) return liveness(request);
    rig.deps.sources!.pipelines = () => pipelines().map((lane) => lane.id === OPEN_LANE[0]!.id ? { ...lane, state: "closed", closedAt: new Date(NOW).toISOString() } : lane);
    rig.deps.sources!.settings = () => ({ ...promptSettings(), monitorPrompt: "Watch the current release.", updatedAt: new Date(NOW).toISOString() });
    return liveness(request);
  };
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake" });
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).not.toContain(OPEN_LANE[0]!.id);
  expect(rig.sent[0]!.text).toContain("Watch the current release.");
  expect(rig.sent[0]!.text).not.toContain(MONITOR_PROMPT);
});

for (const change of ["enabled", "interval"] as const) {
  test(`a ${change} change during gathering refreshes gated pull-request evidence`, async () => {
    const rig = harness({
      pipelines: [{ ...OPEN_LANE[0]!, createdAt: new Date(NOW - 120 * MINUTE).toISOString(), branch: "topic-pr" }],
      state: change === "enabled" ? OVERDUE : { lastWakeAt: new Date(NOW - 31 * MINUTE).toISOString() },
      settings: { ...defaultSeatTickSettings(PROJECT), enabled: change !== "enabled" },
      openPullRequests: [{ number: 1289, title: "Existing work", headRefName: "topic-pr",
        createdAt: new Date(NOW - 90 * MINUTE).toISOString(), updatedAt: new Date(NOW - MINUTE).toISOString() }],
    });
    const liveness = rig.deps.sources!.liveness;
    const pipelines = rig.deps.sources!.pipelines;
    rig.deps.sources!.liveness = async (request) => {
      if (request.project) {
        rig.deps.sources!.pipelines = () => pipelines().map(lane => ({ ...lane, state: "completed" }));
        rig.deps.sources!.settings = () => ({ ...defaultSeatTickSettings(PROJECT), wakeIntervalMinutes: change === "interval" ? 30 : 60 });
      }
      return liveness(request);
    };
    let reads = 0;
    const openPullRequests = rig.deps.sources!.openPullRequests;
    rig.deps.sources!.openPullRequests = async request => { reads++; return openPullRequests(request); };
    expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"] });
    expect(reads).toBe(1);
    expect(rig.sent[0]!.text).toContain("#1289");
  });
}

test("a newly eligible failed PR read preserves its outage accounting", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE,
    settings: { ...defaultSeatTickSettings(PROJECT), enabled: false } });
  const liveness = rig.deps.sources!.liveness;
  const pipelines = rig.deps.sources!.pipelines;
  rig.deps.sources!.liveness = async request => {
    if (request.project) {
      rig.deps.sources!.pipelines = () => pipelines().map(lane => ({ ...lane, state: "completed" }));
      rig.deps.sources!.settings = () => defaultSeatTickSettings(PROJECT);
    }
    return liveness(request);
  };
  rig.deps.sources!.openPullRequests = async () => ({ ok: false, unavailable: "command-failed" });
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "error", delivery: null });
  expect(rig.sent).toEqual([]);
  expect(rig.written.at(-1)!.pullRequestGap).toMatchObject({ gap: "command-failed", attempts: 1 });
});

test("a second state change during PR refresh leaves the alarm unsent", async () => {
  const rig = harness({ pipelines: [{ ...OPEN_LANE[0]!, branch: "topic-pr" }], state: OVERDUE,
    settings: { ...defaultSeatTickSettings(PROJECT), enabled: false } });
  const liveness = rig.deps.sources!.liveness;
  const pipelines = rig.deps.sources!.pipelines;
  rig.deps.sources!.liveness = async request => {
    if (request.project) {
      rig.deps.sources!.pipelines = () => pipelines().map(lane => ({ ...lane, state: "completed" }));
      rig.deps.sources!.settings = () => defaultSeatTickSettings(PROJECT);
    }
    return liveness(request);
  };
  rig.deps.sources!.openPullRequests = async () => {
    rig.deps.sources!.settings = () => ({ ...defaultSeatTickSettings(PROJECT), enabled: false });
    return { ok: true, pullRequests: [] };
  };
  // The bounded retry re-reads the disabled setting and ends quietly.
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", delivery: null });
  expect(record!.detail).toContain("ticking is off for this project");
  expect(rig.sent).toEqual([]);
  expect(rig.written.every(state => state.lastWakeAt === OVERDUE.lastWakeAt)).toBe(true);
});

test("lane churn during every PR refresh still wakes the seat in one check", async () => {
  const rig = harness({ pipelines: [...FINISHED_LANE, ...OPEN_LANE], state: OVERDUE });
  let reads = 0;
  rig.deps.sources!.openPullRequests = async () => {
    const current = rig.deps.sources!.pipelines();
    const at = new Date(NOW + ++reads * MINUTE).toISOString();
    rig.deps.sources!.pipelines = () => current.map(lane => lane.id === OPEN_LANE[0]!.id
      ? { ...lane, updatedAt: at } : lane);
    return { ok: true, pullRequests: [] };
  };
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake" });
  expect(reads).toBe(1);
  expect(rig.sent).toHaveLength(1);
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
});

const localGitWatchdogMode = process.env.LLV_LOCAL_GIT_WATCHDOG_MODE;

test.skipIf(!localGitWatchdogMode)("local Git wake watchdog child", async () => {
  const repo = process.env.LLV_LOCAL_GIT_WATCHDOG_REPO!;
  const tip = process.env.LLV_LOCAL_GIT_WATCHDOG_TIP!;
  const adapter = localGitWatchdogMode!;
  const rig = harness({ pipelines: [...FINISHED_LANE, ...OPEN_LANE], state: OVERDUE,
    stateFile: path.join(SANDBOX, `local-finished-${adapter}.json`) });
  const [finished, ...others] = rig.deps.sources!.pipelines() as never as Array<Record<string, unknown>>;
  rig.deps.sources!.pipelines = () => [{ ...finished, repoDir: repo, branch: "finished-lane", baseBranch: "main", lastPassedCommit: tip }, ...others] as never;
  rig.deps.sources!.openPullRequests = adapter === "blocked"
    ? () => { const until = Date.now() + 5_000; while (Date.now() < until) { /* deliberate blocked-loop control */ } return { ok: false, unavailable: "command-failed" } as never; }
    : adapter === "hung"
      ? () => new Promise(() => {})
      : async () => ({ ok: false, unavailable: "command-failed" });
  rig.deps.workBudgetMs = 2_000;
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake" });
  expect(record!.detail).toContain(adapter === "hung" ? "timed-out" : "command-failed");
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).toContain("local commits");
  expect(rig.sent[0]!.text).toContain(tip.slice(0, 12));
  process.stdout.write(`LOCAL_GIT_WAKE:${adapter}\n`);
});

test.skipIf(!!localGitWatchdogMode)("local commits from a finished lane wake under a parent watchdog", async () => {
  const repo = path.join(SANDBOX, "local-finished-lane");
  fs.mkdirSync(repo, { recursive: true });
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Seat Tick Fixture"]);
  git(["config", "user.email", "fixture"]);
  fs.writeFileSync(path.join(repo, "work.txt"), "base\n");
  git(["add", "work.txt"]);
  git(["commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["switch", "-c", "finished-lane"]);
  fs.writeFileSync(path.join(repo, "work.txt"), "local lane work\n");
  git(["commit", "-am", "finished lane work"]);
  const tip = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", base]);
  git(["update-ref", "-d", "refs/heads/main"]);
  expect(git(["remote"])).toBe("");

  for (const adapter of ["hung", "failed"] as const) {
    const child = spawn(process.execPath, ["test", import.meta.path, "--test-name-pattern", "local Git wake watchdog child"], {
      env: { ...process.env, LLV_LOCAL_GIT_WATCHDOG_MODE: adapter, LLV_LOCAL_GIT_WATCHDOG_REPO: repo, LLV_LOCAL_GIT_WATCHDOG_TIP: tip },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    let timedOut = false;
    // The child keeps its own two-second check budget; allow interpreter
    // startup and fixture imports before that check starts.
    const watchdog = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
    try {
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      expect({ ...result, timedOut, output }).toMatchObject({ code: 0, timedOut: false });
      expect(output).toContain(`LOCAL_GIT_WAKE:${adapter}`);
    } finally { clearTimeout(watchdog); }
  }

  const blocked = spawn(process.execPath, ["test", import.meta.path, "--test-name-pattern", "local Git wake watchdog child"], {
    env: { ...process.env, LLV_LOCAL_GIT_WATCHDOG_MODE: "blocked", LLV_LOCAL_GIT_WATCHDOG_REPO: repo, LLV_LOCAL_GIT_WATCHDOG_TIP: tip },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let blockedOutput = "";
  blocked.stdout.on("data", chunk => { blockedOutput += chunk.toString(); });
  blocked.stderr.on("data", chunk => { blockedOutput += chunk.toString(); });
  let blockedByWatchdog = false;
  const watchdog = setTimeout(() => { blockedByWatchdog = true; blocked.kill("SIGKILL"); }, 2_000);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      blocked.once("error", reject);
      blocked.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect({ ...result, blockedByWatchdog }).toMatchObject({ code: null, signal: "SIGKILL", blockedByWatchdog: true });
    expect(blockedOutput).not.toContain("LOCAL_GIT_WAKE:blocked");
  } finally { clearTimeout(watchdog); }

  for (const merge of [
    { state: "merged", reviewedHead: tip, chain: [tip], mergedHead: tip },
    { state: "queued", reviewedHead: tip, chain: [tip], mergedHead: null },
  ]) {
    const rig = harness({ pipelines: [...FINISHED_LANE], state: { ...OVERDUE, lastProposalAt: new Date(NOW).toISOString() } });
    const [finished] = rig.deps.sources!.pipelines() as never as Array<Record<string, unknown>>;
    rig.deps.sources!.pipelines = () => [{ ...finished, repoDir: repo, branch: "finished-lane", baseBranch: "main", lastPassedCommit: tip } as never];
    rig.deps.sources!.openPullRequests = async () => {
      rig.deps.sources!.pipelines = () => [{ ...finished, repoDir: repo, branch: "finished-lane", baseBranch: "main", lastPassedCommit: tip, merge } as never];
      return { ok: true, pullRequests: [{ number: 41, title: "completed lane work", headRefName: "finished-lane",
        createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }] };
    };
    const record = await runSeatTickCheck(PROJECT, rig.deps);
    expect(record).toMatchObject({ verdict: "quiet" });
    expect(rig.sent).toHaveLength(0);
  }

  const fairRig = harness({ pipelines: [...FINISHED_LANE], state: { ...OVERDUE, lastCheckAt: null } });
  const [template] = fairRig.deps.sources!.pipelines() as never as Array<Record<string, unknown>>;
  const newerMerged = Array.from({ length: 60 }, (_, index) => ({
    ...template!, id: `newer-merged-${String(index).padStart(2, "0")}`,
    createdAt: new Date(NOW - index * 60_000).toISOString(), closedAt: new Date(NOW - index * 60_000).toISOString(),
    repoDir: repo, branch: "finished-lane", baseBranch: "main", lastPassedCommit: base,
  }));
  const olderPending = { ...template!, id: "older-pending-lane", createdAt: "2020-01-01T00:00:00.000Z",
    closedAt: "2020-01-01T00:00:00.000Z", repoDir: repo, branch: "finished-lane", baseBranch: "main", lastPassedCommit: tip };
  fairRig.deps.sources!.pipelines = () => [...newerMerged, olderPending] as never;
  fairRig.deps.sources!.archivedPipelines = () => [];
  fairRig.deps.sources!.openPullRequests = async () => ({ ok: true, pullRequests: [] });
  const { gatherSeatTickInput } = await import("./seatTickSources");
  let scanState = fairRig.deps.readState!(PROJECT);
  let reached = false;
  const shim = path.join(SANDBOX, "slow-git");
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, "git"), "#!/bin/sh\nif [ \"$1\" = merge-base ]; then sleep 0.15; fi\nexec /usr/bin/git \"$@\"\n", { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim}${path.delimiter}${originalPath ?? ""}`;
  try {
    for (let check = 0; check < 8 && !reached; check++) {
      const observation = await gatherSeatTickInput(PROJECT, scanState, DEFAULT_SEAT_TICK_POLICY, fairRig.deps.sources!);
      reached = observation.signals.some(signal => signal.id === "local-unmerged-lane:older-pending-lane");
      scanState = observation.state;
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  expect(reached).toBe(true);
  const progressFile = path.join(SANDBOX, "local-scan-progress.json");
  writeSeatTickState(PROJECT, { ...scanState, accounting: undefined }, progressFile);
  const restartRig = harness({ pipelines: [...FINISHED_LANE], stateFile: progressFile });
  restartRig.deps.sources!.pipelines = () => [...newerMerged, olderPending] as never;
  restartRig.deps.sources!.archivedPipelines = () => [];
  restartRig.deps.sources!.openPullRequests = async () => ({ ok: true, pullRequests: [] });
  let restartedState = restartRig.deps.readState!(PROJECT);
  let recovered = false;
  for (let check = 0; check < 8 && !recovered; check++) {
    const observation = await gatherSeatTickInput(PROJECT, restartedState, DEFAULT_SEAT_TICK_POLICY, restartRig.deps.sources!);
    recovered = observation.signals.some(signal => signal.id === "local-unmerged-lane:older-pending-lane");
    restartedState = observation.state;
  }
  expect(recovered).toBe(true);

  const diagnosticRig = harness({ pipelines: [...FINISHED_LANE], state: OVERDUE });
  const [diagnosticLane] = diagnosticRig.deps.sources!.pipelines() as never as Array<Record<string, unknown>>;
  diagnosticRig.deps.sources!.pipelines = () => [{ ...diagnosticLane, repoDir: repo, branch: "finished-lane", baseBranch: "absent", lastPassedCommit: tip } as never];
  diagnosticRig.deps.sources!.openPullRequests = async () => ({ ok: true, pullRequests: [] });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await gatherSeatTickInput(PROJECT, diagnosticRig.deps.readState!(PROJECT), DEFAULT_SEAT_TICK_POLICY, diagnosticRig.deps.sources!);
    expect(errors.mock.calls.flat().join(" ")).toContain("local Git ancestry unavailable");
  } finally { errors.mockRestore(); }
});

test("a churn wake delivered before process exit is settled once after restart and credits only named lanes", async () => {
  const directory = fs.mkdtempSync(path.join(SANDBOX, "churn-restart-"));
  const stateFile = path.join(directory, "tick.json");
  const receiptFile = path.join(directory, "receipt.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, stateFile);
  for (const phase of ["deliver", "recover", "again"] as const) {
    const script = path.join(directory, `${phase}.test.ts`);
    fs.writeFileSync(script, `import { test, expect } from "bun:test";
      const { fs, harness, runSeatTickCheck, PROJECT, NOW, MINUTE, FINISHED_LANE, OPEN_LANE, CONVERSATION,
        defaultSeatTickSettings } = await import(${JSON.stringify(path.join(import.meta.dir, "seatTickController.fixture.ts"))});
      test("churn restart ${phase}", async () => {
        const phase = ${JSON.stringify(phase)};
        const receiptFile = ${JSON.stringify(receiptFile)};
        const own = { ...FINISHED_LANE[0], src: CONVERSATION };
        const lanes = [own, ...OPEN_LANE];
        if (phase === "recover") lanes.push({ ...own, id: "late-unseen-lane" });
        const rig = harness({ stateFile: ${JSON.stringify(stateFile)}, pipelines: lanes, now: NOW,
          settings: { ...defaultSeatTickSettings(PROJECT), enabled: phase !== "recover" } });
        let reads = 0;
        rig.deps.sources.openPullRequests = async () => {
          const current = rig.deps.sources.pipelines();
          const at = new Date(NOW + ++reads * MINUTE).toISOString();
          rig.deps.sources.pipelines = () => current.map(lane => lane.id === OPEN_LANE[0].id
            ? { ...lane, updatedAt: at } : lane);
          return { ok: true, pullRequests: [] };
        };
        rig.deps.deliver = async message => {
          expect(phase).toBe("deliver");
          expect(fs.existsSync(receiptFile)).toBe(false);
          fs.writeFileSync(receiptFile, JSON.stringify(message));
          process.exit(23); // destination accepted; controller has not received its acknowledgement
        };
        rig.deps.sources.wakeState = async wake => {
          const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
          expect(wake.clientMessageId).toBe(receipt.clientMessageId);
          return "landed";
        };
        const before = rig.deps.readState(PROJECT);
        const record = await runSeatTickCheck(PROJECT, rig.deps);
        expect(record.verdict).toBe("quiet");
        const after = rig.deps.readState(PROJECT);
        expect(after.outstandingWake).toBeNull();
        expect(after.lastWakeAt).toBe(new Date(NOW).toISOString());
        if (phase === "recover") {
          expect(before.outstandingWake).toBeTruthy();
          expect(before.outstandingWake.commit.announcedLanes.length).toBeGreaterThan(0);
          expect(after.announcedLanes).toEqual(before.outstandingWake.commit.announcedLanes);
          expect(after.announcedLanes.some(key => key.includes("late-unseen-lane"))).toBe(false);
        }
      });`);
    const child = spawn(process.execPath, ["test", script], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    expect(code, output).toBe(phase === "deliver" ? 23 : 0);
    if (phase === "deliver") {
      const wake = readSeatTickState(PROJECT, stateFile).outstandingWake!;
      const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      expect(receipt.clientMessageId).toBe(wake.clientMessageId);
      expect(receipt.text).toContain(FINISHED_LANE[0]!.id);
      expect(receipt.text).not.toContain("late-unseen-lane");
      expect(readSeatTickState(PROJECT, stateFile).lastWakeAt).toBe(OVERDUE.lastWakeAt);
    }
  }
});

test("lane churn keeps a real PR source failure visible in durable state", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "canceled-pr-gap-")), "state.json");
  const running = { ...OPEN_LANE[0]!, id: "running-lane" };
  const rig = harness({ stateFile, pipelines: [...FINISHED_LANE, running], state: OVERDUE });
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, stateFile);

  let attempt = 1;
  const pipelines = rig.deps.sources!.pipelines;
  rig.deps.sources!.pipelines = () => {
    // Every freshness read sees a different attempt, including preparation.
    attempt += 1;
    return pipelines().map(lane => lane.id === running.id
      ? { ...lane, runs: [{ stageId: "build", attempts: [{ n: attempt, state: "running", startedAt: new Date(NOW + attempt * MINUTE).toISOString() }] }] as never }
      : lane);
  };
  rig.deps.sources!.openPullRequests = async () => ({ ok: false, unavailable: "command-failed" });

  const first = await runSeatTickCheck(PROJECT, rig.deps);
  const firstGap = readSeatTickState(PROJECT, stateFile).pullRequestGap;
  expect(first).toMatchObject({ verdict: "wake" });
  expect(first!.detail).toContain("command-failed");
  expect(rig.sent).toHaveLength(1);
  expect(firstGap).toMatchObject({ gap: "command-failed", reported: false });
  const since = firstGap!.since;

  rig.deps.sources!.now = () => NOW + 65 * MINUTE;
  const second = await runSeatTickCheck(PROJECT, rig.deps);
  const secondGap = readSeatTickState(PROJECT, stateFile).pullRequestGap;
  expect(second).toMatchObject({ verdict: "wake" });
  expect(second!.detail).toContain("command-failed");
  expect(rig.sent).toHaveLength(2);
  expect(rig.cards.filter(entry => entry.card.kind === "source-unreadable")).toHaveLength(1);
  expect(secondGap).toMatchObject({ gap: "command-failed", reported: true, since });
});

test("a successful PR read under lane churn clears outage accounting and starts the next run fresh", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "canceled-pr-recovery-")), "state.json");
  const running = { ...OPEN_LANE[0]!, id: "running-lane" };
  const previousSince = new Date(NOW - 3 * 60 * MINUTE).toISOString();
  const gap = standingGap({ since: previousSince, attempts: 24, reported: true });
  const rig = harness({ stateFile, pipelines: [...FINISHED_LANE, running], state: { ...OVERDUE, pullRequestGap: gap } });
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, pullRequestGap: gap }, stateFile);

  let attempt = 1;
  let reads = 0;
  const pipelines = rig.deps.sources!.pipelines;
  rig.deps.sources!.openPullRequests = async () => {
    reads++;
    // The lane advances during every PR read while the source recovers.
    const nextAttempt = ++attempt;
    const current = pipelines();
    rig.deps.sources!.pipelines = () => current.map(lane => lane.id === running.id
      ? { ...lane, runs: [{ stageId: "build", attempts: [{ n: nextAttempt, state: "running", startedAt: new Date(NOW + nextAttempt * MINUTE).toISOString() }] }] as never }
      : lane);
    return { ok: true, pullRequests: [] };
  };

  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake" });
  expect(reads).toBe(1);
  expect(rig.sent).toHaveLength(1);
  expect(readSeatTickState(PROJECT, stateFile).pullRequestGap).toBeNull();

  const firstFailure = harness({ stateFile, pipelines: [...FINISHED_LANE, running], now: NOW + 65 * MINUTE,
    pullRequestsUnavailable: "command-failed" });
  await runSeatTickCheck(PROJECT, firstFailure.deps);
  const freshRun = readSeatTickState(PROJECT, stateFile).pullRequestGap;
  expect(freshRun).toMatchObject({ gap: "command-failed", reported: false, attempts: 1 });
  expect(freshRun!.since).toBe(new Date(NOW + 65 * MINUTE).toISOString());

  const secondFailure = harness({ stateFile, pipelines: [...FINISHED_LANE, running], now: NOW + 130 * MINUTE,
    pullRequestsUnavailable: "command-failed" });
  await runSeatTickCheck(PROJECT, secondFailure.deps);
  expect(secondFailure.cards.filter(entry => entry.card.kind === "source-unreadable")).toHaveLength(1);
  expect(readSeatTickState(PROJECT, stateFile).pullRequestGap).toMatchObject({
    gap: "command-failed", reported: true, attempts: 2, since: freshRun!.since,
  });
});

test("a wake interrupted before dispatch refreshes its agenda and note before original-key replay", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "undispatched-alarm-")), "state.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, stateFile);
  const first = harness({ stateFile, pipelines: OPEN_LANE, settings: promptSettings() });
  const beginDispatch = spyOn(SeatTickAccounting.prototype, "beginDispatch").mockImplementationOnce(() => {
    throw new Error("interrupted after durable wake preparation");
  });
  try {
    await runSeatTickCheck(PROJECT, first.deps);
  } finally {
    beginDispatch.mockRestore();
  }
  const prepared = readSeatTickState(PROJECT, stateFile).outstandingWake!;
  expect(prepared).toBeTruthy();
  expect(prepared.dispatch).toBeUndefined();
  expect(first.sent).toEqual([]);

  const replacement = "Use the release monitor note now.";
  const retry = harness({ stateFile, pipelines: [{ ...OPEN_LANE[0]!, id: "current-lane" }], wakeState: "absent",
    now: NOW + 5 * MINUTE, settings: { ...promptSettings(), monitorPrompt: replacement } });
  await runSeatTickCheck(PROJECT, retry.deps);
  expect(retry.sent).toHaveLength(1);
  expect(retry.sent[0]!.clientMessageId).toBe(prepared.clientMessageId);
  expect(retry.sent[0]!.text).not.toContain(OPEN_LANE[0]!.id);
  expect(retry.sent[0]!.text).toContain("current-lane");
  expect(retry.sent[0]!.text).toContain(replacement);
  expect(retry.sent[0]!.text).not.toContain(MONITOR_PROMPT);
});

test("an undispatched wake whose agenda settled is cleared without delivery credit", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "settled-undispatched-alarm-")), "state.json");
  const initial = { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, lastProposalAt: new Date(NOW).toISOString() };
  writeSeatTickState(PROJECT, initial, stateFile);
  const first = harness({ stateFile, pipelines: OPEN_LANE });
  const beginDispatch = spyOn(SeatTickAccounting.prototype, "beginDispatch").mockImplementationOnce(() => {
    throw new Error("interrupted after durable wake preparation");
  });
  try {
    await runSeatTickCheck(PROJECT, first.deps);
  } finally {
    beginDispatch.mockRestore();
  }
  expect(readSeatTickState(PROJECT, stateFile).outstandingWake?.dispatch).toBeUndefined();

  const retry = harness({ stateFile, pipelines: [], wakeState: "absent", now: NOW + 5 * MINUTE });
  await runSeatTickCheck(PROJECT, retry.deps);
  expect(retry.sent).toEqual([]);
  expect(readSeatTickState(PROJECT, stateFile)).toMatchObject({
    outstandingWake: null, lastWakeAt: OVERDUE.lastWakeAt, eventsThrough: 0,
  });
});

test("an absent refused alarm refreshes its agenda and note under its original key", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "fresh-alarm-")), "state.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, stateFile);
  const first = harness({ stateFile, pipelines: OPEN_LANE, state: OVERDUE, settings: promptSettings(), wakeState: "absent",
    delivery: { ok: false, outcome: "failed", error: "temporarily unavailable", status: 503 } });
  await runSeatTickCheck(PROJECT, first.deps);
  const original = readSeatTickState(PROJECT, stateFile).outstandingWake!;
  const next = harness({ stateFile, pipelines: [{ ...OPEN_LANE[0]!, id: "current-lane" }], wakeState: "absent", now: NOW + 5 * MINUTE,
    settings: { ...promptSettings(), monitorPrompt: REPLACEMENT_PROMPT } });
  await runSeatTickCheck(PROJECT, next.deps);
  expect(next.sent).toHaveLength(1);
  expect(next.sent[0]!.clientMessageId).toBe(original.clientMessageId);
  expect(next.sent[0]!.text).not.toContain(OPEN_LANE[0]!.id);
  expect(next.sent[0]!.text).toContain(REPLACEMENT_PROMPT);
  expect(next.sent[0]!.text).not.toContain(MONITOR_PROMPT);
  expect(readSeatTickState(PROJECT, stateFile).noteShown).toBe(seatTickNoteRevisionForTest(REPLACEMENT_PROMPT));
});

test("a refused alarm whose only lane settled is cleared unsent and credits nothing", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "settled-alarm-")), "state.json");
  const initial = { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, lastProposalAt: new Date(NOW).toISOString() };
  writeSeatTickState(PROJECT, initial, stateFile);
  const first = harness({ stateFile, pipelines: OPEN_LANE, wakeState: "absent",
    delivery: { ok: false, outcome: "failed", error: "temporarily unavailable", status: 503 } });
  await runSeatTickCheck(PROJECT, first.deps);
  expect(readSeatTickState(PROJECT, stateFile).outstandingWake).not.toBeNull();
  const next = harness({ stateFile, pipelines: [], wakeState: "absent", now: NOW + 5 * MINUTE });
  expect(await runSeatTickCheck(PROJECT, next.deps)).toMatchObject({ verdict: "quiet" });
  expect(next.sent).toEqual([]);
  const settled = readSeatTickState(PROJECT, stateFile);
  expect(settled).toMatchObject({ outstandingWake: null, lastWakeAt: initial.lastWakeAt, eventsThrough: 0 });
  expect(settled.noteShown ?? null).toBeNull();
});

test("a wake retained by transport identifies its snapshot when delivery is delayed", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, delivery: HELD });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent[0]!.text).toContain(`Snapshot at ${new Date(NOW).toISOString()}`);
  expect(rig.written.at(-1)!.outstandingWake!.text).toBe(rig.sent[0]!.text);
});

test("a proposal refreshes the monitor note after awaiting issue lookup", async () => {
  const rig = harness({ settings: promptSettings() });
  rig.deps.proposalIssues = async () => {
    rig.deps.sources!.settings = () => ({ ...promptSettings(), monitorPrompt: REPLACEMENT_PROMPT });
    return [];
  };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent[0]!.text).toContain(REPLACEMENT_PROMPT);
  expect(rig.sent[0]!.text).not.toContain(MONITOR_PROMPT);
});

test("a slow proposal lookup preserves the oldest evidence timestamp", async () => {
  const rig = harness({ settings: promptSettings() });
  rig.deps.proposalIssues = async () => {
    rig.deps.sources!.now = () => NOW + 10 * MINUTE;
    return [];
  };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent[0]!.text).toContain(`Snapshot at ${new Date(NOW).toISOString()}`);
  expect(rig.sent[0]!.text).not.toContain(`Snapshot at ${new Date(NOW + 10 * MINUTE).toISOString()}`);
});

test("every scheduler wake carries the operator instructions alongside the seat note", async () => {
  const instruction = "Handle incoming tasks by priority; stop when the inbox is empty.";
  const settings = { ...promptSettings(), wakeIntervalMinutes: 30, reason: instruction };
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  await runSeatTickCheck(PROJECT, first.deps);
  expect(first.sent[0]!.text).toContain(`Instructions — author unknown:\n> ${instruction}`);
  expect(first.sent[0]!.text).toContain(MONITOR_PROMPT);
  expect(first.sent[0]!.text).toContain("Items:");

  const next = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, noteShown: seatTickNoteRevisionForTest(MONITOR_PROMPT) }, settings });
  await runSeatTickCheck(PROJECT, next.deps);
  expect(next.sent[0]!.text).toContain(instruction);
  expect(next.sent[0]!.text).toContain("Standing monitor note unchanged");

  const proposal = harness({ settings });
  await runSeatTickCheck(PROJECT, proposal.deps);
  expect(proposal.journal[0]!.verdict).toBe("proactive");
  expect(proposal.sent[0]!.text).toContain(instruction);
  expect(proposal.sent[0]!.text).toContain(MONITOR_PROMPT);

  const edited = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings: { ...settings, reason: "Stop launching tasks until the release settles." } });
  await runSeatTickCheck(PROJECT, edited.deps);
  expect(edited.sent[0]!.clientMessageId).not.toBe(first.sent[0]!.clientMessageId);
  const cleared = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings: { ...settings, reason: null } });
  await runSeatTickCheck(PROJECT, cleared.deps);
  expect(cleared.sent[0]!.clientMessageId).not.toBe(first.sent[0]!.clientMessageId);
  expect(cleared.sent[0]!.text).not.toContain("Operator instructions for every wake:");
});

test("the wake the scheduler fires carries the project's own monitor prompt, check after check (#1280)", async () => {
  const settings = promptSettings();
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  const firstRecord = await runSeatTickCheck(PROJECT, first.deps);
  expect(firstRecord).toMatchObject({ verdict: "wake" });
  expect(first.sent[0]!.text).toContain(MONITOR_PROMPT);
  /* Beside what the tick derived, not instead of it, and the contract still
     has the last word. */
  expect(first.sent[0]!.text).toContain("Items:");
  expect(first.sent[0]!.text).toContain("Contract:");
  expect(first.sent[0]!.text).not.toContain("Act on the listed items only");

  /* The next check reads the same row rather than any memory of the last wake,
     so an hour later the instruction is still on the wake. A prompt the seat
     re-typed into a schedule it made for itself lasted exactly one turn; this
     is the difference. */
  const second = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  await runSeatTickCheck(PROJECT, second.deps);
  expect(second.sent[0]!.text).toContain(MONITOR_PROMPT);
});

test("a rotation hands the monitor prompt on: the successor's first wake carries it (#1280)", async () => {
  const settings = promptSettings();
  const before = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  await runSeatTickCheck(PROJECT, before.deps);
  expect(before.sent[0]!.conversationId).toBe(CONVERSATION);

  /* A different seat, a later epoch: the row is the PROJECT's, so what the
     retired seat asked its monitor to watch is what the successor is woken
     with, rather than dying with the session that wrote it. */
  const after = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: OVERDUE,
    settings,
  });
  await runSeatTickCheck(PROJECT, after.deps);
  expect(after.sent[0]!.conversationId).toBe(SUCCESSOR);
  expect(after.sent[0]!.text).toContain(MONITOR_PROMPT);
});

test("a project with no monitor prompt is woken with exactly the message it was woken with before (#1280)", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent[0]!.text).not.toContain(PROMPT_HEADING);
  /* And a row that exists but carries no prompt is the same silence: an empty
     field is not a section with nothing in it. */
  const configured = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    settings: { ...promptSettings(), monitorPrompt: null },
  });
  await runSeatTickCheck(PROJECT, configured.deps);
  expect(configured.sent[0]!.text).toBe(rig.sent[0]!.text);
});

test("a note the seat's last landed wake carried is one line on the next wake, and a tick with it is about 1.2 KB (#2030)", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "note-unchanged-")), "seat-tick.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, accounting: undefined }, stateFile);
  const settings = { ...promptSettings(), monitorPrompt: LEDGER_NOTE };
  const check = async (now: number, over: Parameters<typeof harness>[0] = {}) => {
    const rig = harness({ stateFile, now, pipelines: busyBoard(now - MINUTE), settings, seat: CURRENT_SEAT, ...over });
    await runSeatTickCheck(PROJECT, rig.deps);
    expect(rig.sent).toHaveLength(1);
    return rig.sent[0]!.text;
  };

  const first = await check(NOW);
  expect(first).toContain(PROMPT_HEADING);
  expect(first).toContain("lane 1: pipeline_0000ab");
  expect(readSeatTickState(PROJECT, stateFile).noteShown).toBeString();

  const second = await check(NOW + 61 * MINUTE);
  expect(second).not.toContain(PROMPT_HEADING);
  expect(second).not.toContain("lane 1: pipeline_0000ab");
  expect(second).toContain(`Standing monitor note unchanged since your last wake (${LEDGER_NOTE.length} chars;`);
  expect(second).toContain("Contract: the \"you never schedule yourself\" section of your mandate governs this turn.");
  for (const clause of ORCHESTRATOR_SEAT_TICK_CONTRACT) expect(second).not.toContain(clause);
  const unchangedBytes = Buffer.byteLength(second);
  expect(unchangedBytes).toBeLessThanOrEqual(1_200);
  console.log(`[#2030] tick bytes: note shown ${Buffer.byteLength(first)}, note unchanged ${unchangedBytes}`);

  /* One replaced line is a different note, and the next wake shows it. */
  const edited = LEDGER_NOTE.replace("lane 1: pipeline_0000ab — review round 2 of 4", "lane 1: pipeline_0000ab — merged");
  const third = await check(NOW + 122 * MINUTE, { settings: { ...settings, monitorPrompt: edited } });
  expect(third).toContain("lane 1: pipeline_0000ab — merged");

  /* A successor never received it: its first wake carries the note whole. */
  const successor = await check(NOW + 183 * MINUTE, {
    seat: { ...CURRENT_SEAT, conversationId: SUCCESSOR, seatEpoch: 8 },
    settings: { ...settings, monitorPrompt: edited },
  });
  expect(successor).toContain(PROMPT_HEADING);
  expect(successor).toContain("lane 1: pipeline_0000ab — merged");
});

/* #2030 review: a seat still running on a v20 mandate — or carried forward on
   one — was delivered the old clock paragraph, which states none of the
   clauses. Its wakes keep them until its mandate does. */
test("a seat whose mandate predates the contract gets its clauses in the wake; a current one gets the line naming them (#2030)", async () => {
  /* A v20 seat carries the opening as it shipped, heading included. */
  const v20Clock = `${ORCHESTRATOR_SHIPPED_CLOCK_OPENING}\nBetween wakes you are idle on purpose, and idle is correct: a seat with nothing owed costs nothing. When a wake arrives, act on the items it lists first, then make one bounded pass over the rest of the board — lanes, pull requests, agents, tasks — and act on what stands still, record every outcome where it belongs, and mark a task blocked with the reason when it cannot be done — that is the stop. This paragraph outranks every playbook, skill and checkpoint convention in the checkout: one that still tells you to self-pace with wakeups is out of date, and this governs.`;
  const v20Seat = { ...CURRENT_SEAT, mandate: ORCHESTRATOR_SYSTEM_PROMPT.replace(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE, v20Clock), promptVersion: 20 };
  const bespoke = { ...CURRENT_SEAT, mandate: "Run this board my way.", promptVersion: null };
  for (const seat of [v20Seat, bespoke]) {
    const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, seat });
    await runSeatTickCheck(PROJECT, rig.deps);
    const text = rig.sent[0]!.text;
    expect(text).toContain(`\nContract:\n- ${SEAT_TICK_NO_SELF_SCHEDULE}\n`);
    for (const clause of ORCHESTRATOR_SEAT_TICK_CONTRACT) expect(text.split(clause)).toHaveLength(2);
    expect(text).not.toContain("section of your mandate governs this turn");
  }
  /* What that costs until the seat rotates: its unchanged-note tick, on the
     board the 1.2 KB case measures. */
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "note-unchanged-v20-")), "seat-tick.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, accounting: undefined }, stateFile);
  const settings = { ...promptSettings(), monitorPrompt: LEDGER_NOTE };
  const ticks: string[] = [];
  for (const now of [NOW, NOW + 61 * MINUTE]) {
    const rig = harness({ stateFile, now, pipelines: busyBoard(now - MINUTE), settings, seat: v20Seat });
    await runSeatTickCheck(PROJECT, rig.deps);
    ticks.push(rig.sent[0]!.text);
  }
  expect(ticks[1]).toContain("Standing monitor note unchanged since your last wake");
  expect(Buffer.byteLength(ticks[1]!)).toBeLessThanOrEqual(1_700);
  console.log(`[#2030] v20 seat tick bytes: note shown ${Buffer.byteLength(ticks[0]!)}, note unchanged ${Buffer.byteLength(ticks[1]!)}`);
  const current = harness({ pipelines: OPEN_LANE, state: OVERDUE, seat: CURRENT_SEAT });
  await runSeatTickCheck(PROJECT, current.deps);
  expect(current.sent[0]!.text).toContain("section of your mandate governs this turn");
  for (const clause of ORCHESTRATOR_SEAT_TICK_CONTRACT) expect(current.sent[0]!.text).not.toContain(clause);
});

test("a wake the layer never landed leaves the note to be shown again (#2030)", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "note-unlanded-")), "seat-tick.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, accounting: undefined }, stateFile);
  const settings = { ...promptSettings(), monitorPrompt: LEDGER_NOTE };
  const refused = harness({ stateFile, now: NOW, pipelines: busyBoard(NOW - MINUTE), settings, deliveryThrows: true });
  await runSeatTickCheck(PROJECT, refused.deps);
  expect(refused.sent[0]!.text).toContain(PROMPT_HEADING);
  expect(readSeatTickState(PROJECT, stateFile).noteShown ?? null).toBeNull();
});

test("a prompt replaced while a wake is outstanding waits for original-key settlement (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, { ...promptSettings(), monitorPrompt: REPLACEMENT_PROMPT });
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).not.toBe(outstanding);
  expect(record.delivery!.outcome).toBe("deferred-outstanding");
  expect(layer.accepted).toHaveLength(1);
});

test("a prompt cleared while a wake is outstanding retains the original attempt (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, { ...promptSettings(), monitorPrompt: null });
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).not.toBe(outstanding);
  /* Withdrawn means withdrawn: the key is the one this wake would have had if
     the project had never set a prompt, and the text carries no note. */
  expect(record.delivery!.clientMessageId).toBe(outstanding.slice(0, outstanding.lastIndexOf(":prompt-")));
  expect(layer.accepted).toHaveLength(1);
});

test("an outstanding wake whose prompt has not changed stays under its original key (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, promptSettings());
  /* Same words, same key, same text: the layer sees the message it is already
     holding, and the seat is spared a second copy of one it may yet receive. */
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).toBe(outstanding);
  expect(layer.accepted.at(-1)!.text).toBe(layer.accepted[0]!.text);
});

test("a promptless wake keeps the exact client message id it had before the prompt existed (#1280)", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  /* Nothing after the fingerprint: a project that never set a prompt is not
     paying for the field with a changed identity. */
  expect(record!.delivery!.clientMessageId).toBe(
    `seat-tick:${PROJECT}:7:${OVERDUE.lastWakeAt}:interval:${rig.written.at(-1)!.lastWakeFingerprint}`);
});

/* The RED assertion this lane was cut for: a running child and nothing else is
   open work with an agenda, and the interval wake carries it. On the code
   before #1465 this check ended `proactive` — a proposal brief dispatched over
   a worker still running. */
test("a running spawned child with no lane is open work, and the interval wake names it (#1465)", async () => {
  const fixture = childFixture("running-child");
  const child = fixture.spawn({ title: "build the exporter", turn: "busy", host: "live" });
  fixture.seed();
  const rig = childRig(fixture, { childActivity: { [child.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });

  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"], items: 1, deferred: 0 });
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(rig.sent[0]!.text).toContain("build the exporter");
  /* A live turn the liveness plane calls running is not a stall, however long
     it has been open. */
  expect(rig.cards).toEqual([]);
  expect(rig.liveness).toEqual([{ conversationId: fixture.seat.conversationId }, { conversationId: child.id }]);
});

/* docs/design/ghost-seat.md §4 rule 5: the tick wakes the active seat and
   nothing else. A live parallel self of that seat — a fork registered with the
   seat as its parent, mid-turn, with its record live — is never the wake's
   target and never one of its items: it answers its one ask and hands its
   result back through the note queued to the seat. */
test("a live deputy of the seat is never woken, and the wake goes to the seat alone", async () => {
  const { beginDeputy, recordDeputyFork, activateDeputy, readDeputies } = await import("@/lib/orchestrator/deputies");
  const fixture = childFixture("live-deputy");
  const worker = fixture.spawn({ title: "build the exporter", turn: "busy", host: "live" });
  const ghostPath = path.join(SESSIONS, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(ghostPath, "");
  const ghost = fixture.registry.ensureForkedConversation("claude", ghostPath, null, {
    cwd: fixture.cwd,
    parentConversationId: fixture.seat.conversationId as never,
    title: "Orchestrator · parallel self",
  });
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: ghostPath,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "Orchestrator · parallel self" }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: new Date(fixture.now - MINUTE).toISOString(),
  }]);
  const begun = beginDeputy({ project: fixture.project, seatConversationId: fixture.seat.conversationId, seatEpoch: 7, seatPath: fixture.seat.path, clientRequestId: `deputy-${crypto.randomUUID()}`, ask: { text: "file a task", images: 0, sender: null }, now: new Date(fixture.now - MINUTE) });
  if (begun.kind !== "begun") throw new Error("deputy did not begin");
  recordDeputyFork(begun.deputy.askId, { deputyConversationId: ghost.id, artifactPath: ghostPath, forkRecordCount: 0 });
  activateDeputy(begun.deputy.askId, new Date(fixture.now - MINUTE));
  expect(readDeputies().find((deputy) => deputy.askId === begun.deputy.askId)?.state).toBe("active");
  fixture.seed();
  const rig = childRig(fixture, { childActivity: { [worker.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });

  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake" });
  expect(rig.sent.map((message) => message.conversationId)).toEqual([fixture.seat.conversationId]);
  expect(rig.sent[0]!.text).toContain(`[child] ${worker.id}`);
  expect(rig.sent[0]!.text).not.toContain(ghost.id);
});

test("a finished child is harvested by exactly one wake, across ticks, a fresh controller and a rotation (#1465)", async () => {
  const fixture = childFixture("finished-child");
  const child = fixture.spawn({ title: "review the exporter", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();

  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, first.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(record!.detail).toContain("a spawned child finished and its outcome is not yet announced by a delivered seat-tick wake");
  expect(first.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(first.sent[0]!.text).toContain("review the exporter");
  /* The landing wrote the cursor: this child is now the seat's business. */
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(fixture.row().lastWakeAt).toBe(new Date(fixture.now).toISOString());

  /* Same controller, the interval elapsed again: nothing owed. */
  const later = fixture.now + 61 * MINUTE;
  const second = childRig(fixture, { now: later });
  expect(await runSeatTickCheck(fixture.project, second.deps)).toMatchObject({ verdict: "quiet", items: 0 });
  expect(second.sent).toEqual([]);

  /* A fresh controller reading the row off disk. */
  const third = childRig(fixture, { now: later });
  expect(await runSeatTickCheck(fixture.project, third.deps)).toMatchObject({ verdict: "quiet" });
  expect(third.sent).toEqual([]);

  /* A rotation: the successor inherits the harvest cursor with the clock. */
  const rotated = childRig(fixture, { now: later, seat: { ...fixture.seat, seatEpoch: 8 } });
  expect(await runSeatTickCheck(fixture.project, rotated.deps)).toMatchObject({ verdict: "quiet", seatEpoch: 8 });
  expect(rotated.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ seatEpoch: 8 });
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a child whose host was released after a settled turn is finished, and harvested once (#1465)", async () => {
  const fixture = childFixture("unhosted-child");
  const child = fixture.spawn({ title: "draft the changelog", turn: "idle", host: "dead" });
  fixture.seed();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  /* Only the seat reachability probe; settled children need no liveness read. */
  expect(rig.liveness).toEqual([{ conversationId: fixture.seat.conversationId }]);
});

test("a launch that failed before it ran is a terminal child with a failed outcome, harvested once (#1465)", async () => {
  const fixture = childFixture("failed-child");
  const child = fixture.spawn({ title: "build the exporter", unobserved: true });
  fixture.registry.failSpawn(child.launchId, "the host could not be started");
  fixture.seed();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(record!.detail).toContain("a spawned child failed");
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id} — build the exporter — spawned child failed, outcome announcement owed`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  const again = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, again.deps)).toMatchObject({ verdict: "quiet" });
});

test("more terminal children than the wake carries leave the rest owed, oldest harvested first (#1465)", async () => {
  const fixture = childFixture("bounded-harvest");
  const oldest = fixture.spawn({ title: "first worker", turn: "terminal", terminalAt: ago(fixture, 30) });
  const middle = fixture.spawn({ title: "second worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const newest = fixture.spawn({ title: "third worker", turn: "terminal", terminalAt: ago(fixture, 10) });
  fixture.seed();
  const policy = { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 1 };

  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, { ...first.deps, policy });
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1, deferred: 2 });
  expect(first.sent[0]!.text).toContain(`[child] ${oldest.id}`);
  expect(first.sent[0]!.text).not.toContain(middle.id);
  expect(fixture.acknowledged()).toEqual([oldest.id]);

  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  const next = await runSeatTickCheck(fixture.project, { ...second.deps, policy });
  expect(next).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1, deferred: 1 });
  expect(second.sent[0]!.text).toContain(`[child] ${middle.id}`);
  expect(new Set(fixture.acknowledged())).toEqual(new Set([oldest.id, middle.id]));

  const third = childRig(fixture, { now: fixture.now + 122 * MINUTE });
  await runSeatTickCheck(fixture.project, { ...third.deps, policy });
  expect(third.sent[0]!.text).toContain(`[child] ${newest.id}`);
  expect(new Set(fixture.acknowledged())).toEqual(new Set([oldest.id, middle.id, newest.id]));
});

test("every owed child beyond the cursor cap is named once across landings and restarts (#1465)", async () => {
  const fixture = childFixture("harvest-capacity");
  const owed = Array.from({ length: 205 }, (_, index) => fixture.spawn({
    title: `worker ${index}`,
    turn: "terminal",
    terminalAt: ago(fixture, 300 - index),
  }));
  fixture.seed();
  let projectedRows = 0;
  const pageChildren = fixture.registry.pageSeatChildren.bind(fixture.registry);
  fixture.registry.pageSeatChildren = (...args) => {
    const page = pageChildren(...args);
    projectedRows += page?.keys.length ?? 0;
    return page;
  };
  const named: string[] = [];
  for (let tick = 0; tick < 45; tick += 1) {
    projectedRows = 0;
    // Each check constructs a fresh controller over the same durable row.
    const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE });
    await runSeatTickCheck(fixture.project, {
      ...rig.deps,
      policy: { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 5 },
    });
    expect(projectedRows).toBeLessThanOrEqual(60);
    expect(rig.snapshots).toBe(0);
    expect(rig.liveness.length).toBeLessThanOrEqual(60);
    for (const message of rig.sent) {
      for (const match of message.text.matchAll(/^- \[child\] (\S+) .*outcome announcement owed$/gm)) named.push(match[1]!);
    }
  }
  const unique = new Set(named);
  expect({ named: named.length, unique: unique.size, missing: owed.filter((child) => !unique.has(child.id)).length })
    .toEqual({ named: 205, unique: 205, missing: 0 });
}, 180_000);

test("a harvested child the seat re-instructs is owed again when it next finishes (#1465)", async () => {
  const fixture = childFixture("reinstructed-child");
  const child = fixture.spawn({ title: "iterate on the exporter", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture).deps);
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* The seat sent it more work: the turn is open again under a live host. */
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "iterate on the exporter" }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: ago(fixture, 1),
  }]);
  fixture.registry.upsert({
    key: sessionKeyFromTranscript("claude", child.path)!,
    artifactPath: child.path,
    cwd: fixture.cwd,
    accountId: null,
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const running = childRig(fixture, { now: fixture.now + 61 * MINUTE, childActivity: { [child.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });
  expect(await runSeatTickCheck(fixture.project, running.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(fixture.acknowledged()).toEqual([child.id]);

  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "iterate on the exporter" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: new Date(fixture.now + 90 * MINUTE).toISOString() },
    observedAt: new Date(fixture.now + 90 * MINUTE).toISOString(),
  }]);
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  ledger.append(generation, { kind: "turn-started", turnId: "reinstructed", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "reinstructed", status: "completed", seq: 4 });
  const finished = childRig(fixture, { now: fixture.now + 122 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, finished.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"] });
  expect(fixture.acknowledged()).toEqual([child.id, child.id]);
});

test("a wake the record still holds is retained: no stamp moves and the row keeps it (#1465)", async () => {
  const fixture = childFixture("receipt-assigned");
  setAgentRegistryForTests(fixture.registry);
  const wake = recordedWake(fixture, { state: "assigned" });
  fixture.seed({ outstandingWake: wake, eventsThrough: 3 });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal.map((line) => line.verdict)).toEqual([record!.verdict]);
  expect(fixture.row()).toMatchObject({ outstandingWake: wake, lastWakeAt: ago(fixture, 61), eventsThrough: 3, harvestedChildren: [] });
});

test("a wake the record says was delivered lands, on the plan the raising check wrote (#1465)", async () => {
  const fixture = childFixture("receipt-delivered");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const Clock = Date;
  globalThis.Date = new Proxy(Clock, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [fixture.now]); },
    get(target, key, receiver) { return key === "now" ? () => fixture.now : Reflect.get(target, key, receiver); },
  });
  const wake = recordedWake(fixture, { state: "delivered", children: [child.id] });
  fixture.seed({ outstandingWake: wake, eventsThrough: 1 });
  const rig = childRig(fixture, { realWakeState: true });
  await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: wake.clientMessageId, outcome: "landed" } });
  expect(fixture.row()).toMatchObject({
    outstandingWake: null,
    lastWakeAt: new Date(fixture.now).toISOString(),
    eventsThrough: 3,
    harvestedChildren: [],
  });
  expect(fixture.acknowledged()).toContain(child.id);
  /* The landing credited the harvest, so the same check has nothing to raise. */
  expect(rig.sent).toEqual([]);
});

test("a wake the record proves was never delivered is dropped, and raised again in the same check (#1465)", async () => {
  const fixture = childFixture("receipt-lost");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "lost", children: [child.id] });
  fixture.seed({ outstandingWake: wake });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal[0]).toMatchObject({ verdict: "dropped" });
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(rig.sent).toHaveLength(1);
  expect(fixture.row()).toMatchObject({ outstandingWake: null });
  expect(fixture.acknowledged()).toContain(child.id);
});

/* A terminal receipt the host ended without verifying — it took the message
   and died — is missing evidence, not proof of loss (#1465). The attempt keeps
   its key: nothing it carried is acknowledged, no wake replaces it under any
   key, and neither the deadline nor a re-designation of the same conversation
   changes that. What changes is that the board says so, once, the moment it is
   seen, because no evidence will settle this on its own — and that the fence
   it holds is bounded (#1746): spent, the attempt is retired unresolved and
   the obligations it named are re-derived into a wake that does go out. */
test("a wake the record ended without proof keeps its identity inside its bound, carded once and never replaced, and is retired unresolved past it (#1465, #1746)", async () => {
  const fixture = childFixture("receipt-unverified");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "unverified", children: [child.id] });
  fixture.seed({ outstandingWake: wake, eventsThrough: 1 });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal[0]).toMatchObject({ verdict: "uncertain", delivery: { clientMessageId: wake.clientMessageId, outcome: "uncertain" } });
  expect(rig.journal[0]!.detail).toContain("no wake replaces it");
  /* Nothing credited, nothing replaced, and the board carries it now. */
  expect(fixture.row()).toMatchObject({ outstandingWake: { ...wake, preparedAt: new Date(fixture.now).toISOString() }, lastWakeAt: ago(fixture, 61), eventsThrough: 1, harvestedChildren: [] });
  expect(fixture.acknowledged()).toEqual([]);
  expect(record).toMatchObject({ verdict: "wake", delivery: { clientMessageId: expect.not.stringMatching(wake.clientMessageId), outcome: "deferred-outstanding" } });
  expect(rig.sent).toEqual([]);
  expect(rig.cards.map((entry) => entry.card)).toMatchObject([{ ref: SEAT_TICK_WAKE_UNRESOLVED_REF, kind: "wake-unresolved", instance: wake.clientMessageId }]);
  expect(rig.cards[0]!.card.detail).toContain('last answered "uncertain"');
  expect(rig.cards[0]!.card.detail).toContain("dispatches no replacement wake");

  /* Past the wake interval, and past a re-designation of the SAME conversation
     at a higher epoch — one seat, so no supersession (#1594) — with the first
     send's fate still unknown and its own bound not yet spent: the same key, no
     send under any key, nothing acknowledged. The bound is two wake intervals
     and never under an hour, so a check at 61 and at 119 minutes is inside it. */
  for (const [minutes, seat] of [[61, fixture.seat], [119, { ...fixture.seat, seatEpoch: 8 }]] as const) {
    const later = childRig(fixture, { realWakeState: true, now: fixture.now + minutes * MINUTE, seat });
    const deferred = await runSeatTickCheck(fixture.project, later.deps);
    expect(later.sent).toEqual([]);
    expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: wake.clientMessageId, seatEpoch: 7 });
    expect(fixture.row().lastWakeAt).toBe(ago(fixture, 61));
    expect(fixture.acknowledged()).toEqual([]);
    /* And the deferral says why it is mute: which key holds the project's
       wakes, since when, and when that ends on its own (#1746). */
    expect(deferred!.detail).toContain(`fenced by the wake prepared ${new Date(fixture.now).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(deferred!.detail).toContain(`under key ${wake.clientMessageId}`);
    expect(deferred!.detail).toContain(`the fence lapses at ${new Date(fixture.now + 120 * MINUTE).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    /* One occurrence, one card: the board's create receipt collapses the rest. */
    expect(later.cards.map((entry) => entry.card.instance)).toEqual([wake.clientMessageId]);
  }

  /* The bound spent, with the record still unable to prove anything either way:
     the attempt is retired unresolved — same key, never re-sent, crediting
     nothing — and the same check derives its own wake from the obligations it
     named and delivers it (#1746). */
  const past = childRig(fixture, { realWakeState: true, now: fixture.now + 122 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
  const woken = await runSeatTickCheck(fixture.project, past.deps);
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(past.sent).toHaveLength(1);
  expect(past.sent[0]!.clientMessageId).not.toBe(wake.clientMessageId);
  expect(past.sent[0]!.text).toContain(`[child] ${child.id}`);
  const retirement = past.journal.find((line) => line.verdict === "retired")!;
  expect(retirement).toMatchObject({ delivery: { clientMessageId: wake.clientMessageId } });
  expect(retirement.detail).toContain("retired unresolved on its age bound");
  expect(retirement.detail).toContain("never re-sent");
  expect(retirement.detail).toContain("credits nothing");
  expect(fixture.row().outstandingWake).toBeNull();
  expect(fixture.row().retiredWakes).toMatchObject([{ wake: { clientMessageId: wake.clientMessageId }, supersededBy: null, reason: "unresolved-age" }]);
  /* The obligation reappeared in the wake that went out, and was credited
     exactly once — by that wake, not by the attempt that was retired. */
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* And when the holder finally answers for the retired attempt, the answer
     credits nothing: the check that retired it already re-derived what it
     named, and crediting both would acknowledge the same obligation twice. */
  const settled = childRig(fixture, { realWakeState: true, now: fixture.now + 260 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 }, wakeState: "landed" });
  await runSeatTickCheck(fixture.project, { ...settled.deps, sources: { ...settled.deps.sources!, wakeState: async () => "landed" } });
  const landing = settled.journal.find((line) => line.verdict === "landed")!;
  expect(landing.detail).toContain("retired unresolved on its age bound was delivered after all");
  expect(landing.detail).toContain("nothing it carried is credited");
  expect(fixture.row().retiredWakes).toEqual([]);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

/* An attempt no holder can account for — absent record, no runtime operation,
   or a record nobody can read — is kept under its key while its own bound
   runs (#1465). One wake interval is not permission to redeliver: the wait goes
   on the board, and that is all that changes. Two of them is (#1746): a fence
   nothing can ever settle is retired unresolved, and the tick starts again. */
test("a wake nobody can account for is kept under its key past the deadline and carded once, until its bound is spent (#1465, #1746)", async () => {
  const fixture = childFixture("receipt-aged-unknown");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  /* A send that once held an operation: absent beside a handle is unknown. */
  const wake = recordedWake(fixture, { state: "none", operationId: "op-compacted-1" });
  fixture.seed({ outstandingWake: wake });
  const first = childRig(fixture, { realWakeState: true });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(fixture.row().outstandingWake).toEqual({ ...wake, preparedAt: new Date(fixture.now).toISOString() });
  expect(first.cards).toEqual([]);
  expect(first.sent).toEqual([]);
  const within = childRig(fixture, { realWakeState: true, now: fixture.now + 29 * MINUTE });
  await runSeatTickCheck(fixture.project, within.deps);
  expect(within.cards).toEqual([]);
  expect(within.sent).toEqual([]);

  const aged = childRig(fixture, { realWakeState: true, now: fixture.now + 61 * MINUTE });
  const record = await runSeatTickCheck(fixture.project, aged.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(aged.journal.map((line) => line.verdict)).toEqual(["wake"]);
  expect(aged.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ outstandingWake: { clientMessageId: wake.clientMessageId, operationId: "op-compacted-1" }, lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  expect(fixture.acknowledged()).toEqual([]);
  expect(aged.cards.map((entry) => entry.card)).toMatchObject([{ ref: SEAT_TICK_WAKE_UNRESOLVED_REF, instance: wake.clientMessageId }]);
  expect(aged.cards[0]!.card.detail).toContain('last answered "unknown"');
  /* A holder that cannot be read at all is the same wait, said the same way —
     and a read that proves nothing is exactly what the bound is for. Two wake
     intervals after the attempt was prepared it is retired unresolved on its
     age, the board says so, and this project's wakes flow again (#1746). */
  const unreadable = childRig(fixture, { realWakeState: true, now: fixture.now + 122 * MINUTE });
  const woken = await runSeatTickCheck(fixture.project, { ...unreadable.deps, sources: { ...unreadable.deps.sources!, wakeState: async () => { throw new Error("the delivery record could not be read"); } } });
  expect(unreadable.cards[0]!.card.detail).toContain("could not be read");
  expect(unreadable.cards[0]!.card.detail).toContain("retired unresolved on its age bound");
  expect(fixture.row().outstandingWake).toBeNull();
  expect(fixture.row().retiredWakes).toMatchObject([{ wake: { clientMessageId: wake.clientMessageId }, supersededBy: null, reason: "unresolved-age" }]);
  expect(woken).toMatchObject({ verdict: "wake", delivery: { outcome: "delivered" } });
  expect(unreadable.sent).toHaveLength(1);
  expect(unreadable.sent[0]!.clientMessageId).not.toBe(wake.clientMessageId);

  /* And the next check does not put a second wake beside the first: the wake
     that went out landed, so there is nothing owed and nothing prepared. */
  const after = childRig(fixture, { realWakeState: true, now: fixture.now + 127 * MINUTE });
  await runSeatTickCheck(fixture.project, { ...after.deps, sources: { ...after.deps.sources!, wakeState: async () => { throw new Error("the delivery record could not be read"); } } });
  expect(after.sent).toEqual([]);
  expect(fixture.row().outstandingWake).toBeNull();
});

/* The `uncertain` line these endings write has to survive the journal it is
   written to: a verdict the reader does not know is a line nobody can read
   back, and the journal is the audit trail the operator is pointed at. */
test("an uncertain journal line reads back from the seat tick journal (#1465)", () => {
  const file = path.join(fs.mkdtempSync(path.join(SANDBOX, "journal-")), "runs.ndjson");
  const record: SeatTickRunRecord = {
    schemaVersion: 1, at: new Date(NOW).toISOString(), project: PROJECT, seatEpoch: 7, verdict: "uncertain", reasons: [], items: 0, deferred: 0,
    eventsThrough: 3, delivery: { clientMessageId: "seat-tick:viewer:7:first:interval:fp-1", outcome: "unresolved" }, detail: "ended unverified",
  };
  appendSeatTickRecord(record, file);
  expect(readSeatTickRecords(10, file)).toEqual([record]);
});

test("a wake the record has no trace of is unknown, and a different wake waits behind it (#1465)", async () => {
  const fixture = childFixture("receipt-absent");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "none", operationId: null });
  fixture.seed({ outstandingWake: wake });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal.map((line) => line.verdict)).toEqual(["wake"]);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(rig.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ outstandingWake: wake, lastWakeAt: ago(fixture, 61) });
});

test("a registry that cannot be read fails the check outright, and moves nothing (#1465)", async () => {
  const fixture = childFixture("receipt-unreadable");
  setAgentRegistryForTests(fixture.registry);
  const wake = recordedWake(fixture, { state: "assigned" });
  fixture.seed({ outstandingWake: wake });
  fixture.registry.seatTickConversation = () => { throw new Error("registry unavailable"); };
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  /* The seat's own turn is read off the same registry, so the whole check
     ends as an error line: no wake, no stamp, and the row keeps the wake. */
  expect(record).toMatchObject({ verdict: "error", delivery: null });
  expect(record!.detail).toContain("the check failed");
  expect(fixture.row()).toMatchObject({ outstandingWake: wake, lastWakeAt: ago(fixture, 61) });
  expect(rig.sent).toEqual([]);
});

test("a snapshot that cannot be taken leaves the children unread: a wake names the gap, and nothing else owed is an error (#1465)", async () => {
  const fixture = childFixture("children-unreadable");
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture);
  const registry = fixture.registry;
  const blind = {
    ...rig.deps.sources!,
    registry: () => ({
      seatTickConversation: registry.seatTickConversation.bind(registry),
            conversation: (id: string) => registry.conversation(id as never),
      conversationForPath: (artifactPath: string) => registry.conversationForPath(artifactPath),
      readOnlySnapshot: () => { throw new Error("the registry snapshot is being rewritten"); },
    }) as never,
  };
  const record = await runSeatTickCheck(fixture.project, { ...rig.deps, sources: blind });
  expect(record).toMatchObject({ verdict: "error" });
  expect(record!.detail).toBe("the seat's spawned children could not be read (registry-unreadable): the registry read failed, so nothing owed is not established");
  expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  expect(rig.sent).toEqual([]);

  /* A reason that stands on its own still wakes, and the wake names the gap. */
  const withCard = childRig(fixture, { tasks: [{ id: "task_c2", status: "assigned" }] });
  const cardSources = { ...withCard.deps.sources!, registry: blind.registry, tasks: () => [{ id: "task_c2", project: fixture.project, status: "assigned", text: "card", placement: "unplaced", assignments: [], createdAt: ago(fixture, 30), updatedAt: ago(fixture, 30) }] as never };
  const woken = await runSeatTickCheck(fixture.project, { ...withCard.deps, sources: cardSources });
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["unstarted-task"] });
  expect(woken!.detail).toContain("the seat's spawned children could not be read (registry-unreadable)");
  expect(withCard.sent[0]!.text).toContain("registry-unreadable");
});

test("an absorbing refusal that names an operation is recorded outstanding under it (#1465)", async () => {
  const fixture = childFixture("absorbing-refusal");
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, {
    delivery: { ok: false, outcome: "failed", error: "an earlier attempt began actuating", status: 409, actuation: "started", operationId: "op-absorbed-1", resend: "verify-first" },
    wakeState: "retained",
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "failed" } });
  expect(fixture.row().outstandingWake).toMatchObject({
    clientMessageId: record!.delivery!.clientMessageId,
    operationId: "op-absorbed-1",
    commit: { reasons: ["child-terminal"], children: [outcomeIdentity(["claude", fixture.registry.conversation(child.id as never)!.generations[0]!.id, "turn-one"])] },
  });
  expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
});

test("a send that never returned is looked up under its own key, and kept outstanding when the record holds it (#1465)", async () => {
  const fixture = childFixture("send-threw-reserved");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, {
    deliverWith: async (message) => {
      /* The layer reserved the key and queued the runtime operation, then the
         control channel died before the answer came back. */
      fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, { operationId: "op-unreturned-1", kind: "send", policy: "queue" });
      throw new Error("Viewer control did not reconnect after 2 attempts");
    },
    realWakeState: true,
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(fixture.row().outstandingWake).toMatchObject({
    clientMessageId: record!.delivery!.clientMessageId,
    operationId: "op-unreturned-1",
    commit: { children: [outcomeIdentity(["claude", fixture.registry.conversation(child.id as never)!.generations[0]!.id, "turn-one"])] },
  });
  expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  /* The next check asks the record: still assigned, so still retained, and
     the same wake is not dispatched a second time under a fresh key. */
  const next = childRig(fixture, { realWakeState: true, deliveryThrows: true });
  const again = await runSeatTickCheck(fixture.project, next.deps);
  expect(again!.delivery!.clientMessageId).toBe(record!.delivery!.clientMessageId);
  expect(next.sent).toHaveLength(0);
});

test("a send that never returned and left no record retains its original prepared attempt (#1465)", async () => {
  const fixture = childFixture("send-threw-absent");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, { deliveryThrows: true, realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(fixture.row()).toMatchObject({ outstandingWake: { clientMessageId: record!.delivery!.clientMessageId }, lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  expect(rig.journal).toHaveLength(1);
});

test("a send that never returned with an unreadable record is kept outstanding without a handle (#1465)", async () => {
  const fixture = childFixture("send-threw-unreadable");
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, { deliveryThrows: true });
  const record = await runSeatTickCheck(fixture.project, {
    ...rig.deps,
    sources: { ...rig.deps.sources!, originalSend: async () => ({ kind: "unreadable", reason: "the delivery record could not be read" }) },
  });
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: record!.delivery!.clientMessageId, operationId: null });
});

test("a child finishing while a wake is unresolved dispatches nothing, and is harvested by the wake after the landing (#1465)", async () => {
  const fixture = childFixture("child-finishes-mid-flight");
  const child = fixture.spawn({ title: "long worker", turn: "busy", host: "live" });
  fixture.seed();
  const activity: Record<string, Partial<AgentLivenessRecord>> = { [child.id]: { lifecycle: "running", reason: "host_alive_turn_active" } };
  const first = childRig(fixture, {
    childActivity: activity,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-flight-1", receipt: {} as never, structured: true },
    wakeState: "retained",
  });
  const raised = await runSeatTickCheck(fixture.project, first.deps);
  expect(raised).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(fixture.row().outstandingWake).toMatchObject({ operationId: "op-flight-1", commit: { children: [] } });

  /* The child finishes while the runtime still holds the interval wake. */
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "long worker" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 1) },
    observedAt: ago(fixture, 1),
  }]);
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-one", seq: 1 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-one", status: "completed", seq: 2 });
  const second = childRig(fixture, { wakeState: "retained" });
  const withheld = await runSeatTickCheck(fixture.project, second.deps);
  expect(withheld).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "deferred-outstanding" } });
  expect(second.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ outstandingWake: { operationId: "op-flight-1" }, harvestedChildren: [] });

  /* Once the holder lands the interval wake, the newly owed outcome can
     dispatch in this check; the prior wake credits no child outcome. */
  const third = childRig(fixture, { wakeState: "landed" });
  expect(await runSeatTickCheck(fixture.project, third.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"] });
  expect(third.journal[0]).toMatchObject({ verdict: "landed" });
  expect(third.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  const fourth = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  expect((await runSeatTickCheck(fixture.project, fourth.deps))!.reasons).not.toContain("child-terminal");
  expect(fourth.sent).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * What is NOT this seat's to wake on (#1465).
 * ------------------------------------------------------------------------- */

test("cross-project, pipeline-owned, engine-native and unrelated conversations add nothing (#1465)", async () => {
  const fixture = childFixture("exclusions");
  const elsewhere = path.join(fixture.dir, "other-repo");
  fs.mkdirSync(elsewhere);
  fixture.spawn({ title: "another project's worker", turn: "terminal", terminalAt: ago(fixture, 20), cwd: elsewhere });
  fixture.spawn({
    title: "a pipeline stage",
    turn: "terminal",
    terminalAt: ago(fixture, 20),
    memberships: [{ kind: "pipeline", containerId: "pipeline_x1", role: "builder", slot: "build", stageId: "build", stageOrder: 1, round: 1, parentConversationId: fixture.seat.conversationId as never }],
  });
  /* An engine-native edge: the engine itself recorded the parent, no Viewer
     spawn was ever asked for. */
  const nativePath = path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`);
  fixture.registry.ensureConversation("claude", nativePath, null);
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: nativePath,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "a native fork", parentConversationId: fixture.seat.conversationId as never }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 20) },
    observedAt: ago(fixture, 20),
  }]);
  const edges = Object.values(fixture.registry.readOnlySnapshot().lineageEdges);
  expect(edges.some((edge) => edge.source === "engine-native")).toBe(true);
  /* A conversation started by hand, with no edge at all. */
  const manualPath = path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`);
  fixture.registry.ensureConversation("claude", manualPath, null);
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: manualPath,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "started by hand" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 20) },
    observedAt: ago(fixture, 20),
  }]);
  /* A child of another seat entirely. */
  const otherSeat = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  fixture.spawn({ title: "another seat's worker", turn: "terminal", terminalAt: ago(fixture, 20), parent: otherSeat.id });
  fixture.seed();

  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify; the proposal slot is not due" });
  expect(rig.sent).toEqual([]);
  expect(rig.liveness).toEqual([{ conversationId: fixture.seat.conversationId }]);
});

test("a child the registry cannot place is unknown: not open work, not harvested, and said so (#1465)", async () => {
  const fixture = childFixture("unknown-child");
  fixture.spawn({ title: "a reservation nothing settled", unobserved: true });
  fixture.seed();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "error" });
  expect(record!.detail).toContain("(child-unplaced): a child has no conversation record");
  expect(rig.sent).toEqual([]);
  expect(fixture.acknowledged()).toEqual([]);
  /* The condition is a run of its own, and outliving the wake interval puts it
     on the board once with its own clause (#1465). */
  expect(fixture.row().childrenGap).toMatchObject({ gap: "child-unplaced", attempts: 1, reported: false });
  const standing = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, standing.deps);
  expect(standing.cards.map((entry) => entry.card)).toMatchObject([{ ref: "seat-tick-source-children", kind: "source-unreadable", instance: fixture.row().childrenGap!.since }]);
  expect(standing.cards[0]!.card.detail).toContain("child-unplaced, 2 attempt(s)");
  expect(fixture.row().childrenGap).toMatchObject({ reported: true });
  const quiet = childRig(fixture, { now: fixture.now + 66 * MINUTE });
  await runSeatTickCheck(fixture.project, quiet.deps);
  expect(quiet.cards).toEqual([]);
});

test("the seat's Copilot child with a conversation but no observed turn keeps child-unplaced visible (#2081)", async () => {
  /* The production child is this seat's Viewer spawn. Its launch completed and
     its transcript ended, but its registry turn stayed unknown/source empty.
     The gap names an unobserved turn; there is a conversation record. */
  const fixture = childFixture("copilot-unobserved-turn");
  const child = fixture.spawn({ title: "smoke worker", engine: "copilot", unreconciled: true, completedReceipt: true });
  fixture.seed();
  expect(fixture.registry.conversation(child.id as never)!.turn).toMatchObject({ state: "unknown", source: "empty" });
  const snapshot = fixture.registry.readOnlySnapshot();
  expect(snapshot.receipts[child.launchId]!.state).toBe("completed");
  expect(Object.values(snapshot.entries).find((entry) => entry.artifactPath === child.path)?.status).toBe("dead");

  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "error", reasons: [], items: 0 });
  expect(record!.detail).toContain("child-unplaced");
  expect(fixture.row().childrenGap).toMatchObject({ gap: "child-unplaced", attempts: 1 });
  expect(rig.sent).toEqual([]);
});

test("another seat's unreadable Copilot child leaves this seat's quiet check unblocked (#2081)", async () => {
  const fixture = childFixture("other-seat-copilot-unobserved");
  const otherSeat = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  const child = fixture.spawn({ title: "other seat worker", engine: "copilot", parent: otherSeat.id,
    unreconciled: true, completedReceipt: true });
  fixture.seed();
  expect(fixture.registry.conversation(child.id as never)!.turn).toMatchObject({ state: "unknown", source: "empty" });

  const rig = childRig(fixture);
  expect(await runSeatTickCheck(fixture.project, rig.deps)).toMatchObject({ verdict: "quiet" });
  expect(fixture.row().childrenGap).toBeNull();
  expect(rig.sent).toEqual([]);
});

test("a cold inbox with no children stays quiet, and no heartbeat card is needed (#1465)", async () => {
  const fixture = childFixture("cold-inbox");
  fixture.seed();
  const rig = childRig(fixture, { tasks: [{ id: "task_c1", status: "inbox" }] });
  /* The harness's cards belong to the default project; a seat with an inbox
     card and no child of its own has an empty agenda either way. */
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(rig.sent).toEqual([]);
});

test("a busy child whose host is gone is a stall the registry can see, reported after a second check (#1465)", async () => {
  const fixture = childFixture("gone-child");
  const child = fixture.spawn({ title: "worker whose host died", turn: "busy", host: "dead" });
  fixture.seed();
  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, first.deps);
  /* Open work, so the interval wakes; the stall waits for its second check. */
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(first.liveness).toEqual([{ conversationId: fixture.seat.conversationId }]);
  expect(fixture.row().stalledSeen).toEqual([`child:${child.id}`]);
  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  const stalled = await runSeatTickCheck(fixture.project, second.deps);
  expect(stalled).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  expect(stalled!.detail).toContain("host_gone_turn_open");
  expect(second.sent[0]!.text).toContain(`[child] ${child.id}`);
});

test("the projection uses bounded keyed registry reads and targeted liveness without transcripts (#1465)", async () => {
  const fixture = childFixture("bounded-read");
  const busy = fixture.spawn({ title: "busy worker", turn: "busy", host: "live" });
  const idle = fixture.spawn({ title: "idle worker", turn: "idle", host: "live" });
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, { childActivity: { [busy.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 3 });
  /* The child source uses keyed projections without a registry snapshot. */
  expect(rig.snapshots).toBe(0);
  /* One seat probe plus the one child whose turn is open, all by id.
     No project-wide read or extra child probe is admitted. */
  expect(rig.liveness).toEqual([{ conversationId: fixture.seat.conversationId }, { conversationId: busy.id }]);
  expect(rig.liveness.some((read) => read.project)).toBe(false);
  /* The fixture's transcripts exist, so the harvest can resolve them (#1783),
     and they are empty: nothing here read a byte of transcript CONTENT. */
  expect(fs.statSync(busy.path).size).toBe(0);
  expect(fs.statSync(idle.path).size).toBe(0);
});

test("two later turns between ticks are separately owed across controller replacement and seat rotation (#1465)", async () => {
  const fixture = childFixture("multiple-turns");
  const child = fixture.spawn({ title: "iterative worker", turn: "terminal" });
  fixture.seed();
  const first = childRig(fixture);
  await runSeatTickCheck(fixture.project, first.deps);
  expect(first.sent).toHaveLength(1);
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "completed", seq: 4 });
  ledger.append(generation, { kind: "turn-started", turnId: "turn-three", seq: 5 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-three", status: "error", seq: 6 });
  const next = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
  const result = await runSeatTickCheck(fixture.project, next.deps);
  /* Two later turns of ONE child are one line since #1783, described by the
     latest of them — and the line still stands for both, so both are
     acknowledged by its landing and neither is offered again. */
  expect(result).toMatchObject({ verdict: "wake", items: 1 });
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  const outcomes = accounting.collection.snapshot().filter((row) => row.kind === "outcome");
  expect(outcomes).toHaveLength(3);
  expect(outcomes.every((row) => row.status === "acknowledged")).toBe(true);
  expect(new Set(outcomes.map((row) => row.identity)).size).toBe(3);
  const again = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
  await runSeatTickCheck(fixture.project, again.deps);
  expect(again.sent).toHaveLength(0);
});

test("a new turn discovered during an unknown send remains owed under the original wake fence (#1465)", async () => {
  const fixture = childFixture("unknown-send-turn");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const first = childRig(fixture, { deliveryThrows: true, wakeState: "unknown" });
  await runSeatTickCheck(fixture.project, first.deps);
  expect(first.sent).toHaveLength(1);
  const outstanding = fixture.row().outstandingWake!;
  expect(outstanding.text).toBe(first.sent[0]!.text);
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "next-turn", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "next-turn", status: "completed", seq: 4 });
  /* Past the wake interval, an unaccounted, unverified or retained attempt
     keeps its fence: no send under any key, no acknowledgment, the same key. */
  for (const wakeState of ["unknown", "uncertain", "retained"] as const) {
    const next = childRig(fixture, { now: fixture.now + 61 * MINUTE, wakeState });
    await runSeatTickCheck(fixture.project, next.deps);
    expect(next.sent).toHaveLength(0);
    expect(fixture.row().outstandingWake!.clientMessageId).toBe(outstanding.clientMessageId);
    expect(fixture.acknowledged()).toEqual([]);
  }
  const landed = childRig(fixture, { now: fixture.now + 61 * MINUTE, wakeState: "landed" });
  expect(await runSeatTickCheck(fixture.project, landed.deps)).toMatchObject({ verdict: "wake", items: 1 });
  expect(fixture.acknowledged()).toEqual([child.id, child.id]);
  const final = childRig(fixture, { now: fixture.now + 122 * MINUTE });
  expect((await runSeatTickCheck(fixture.project, final.deps))!.reasons).not.toContain("child-terminal");
  expect(fixture.acknowledged()).toEqual([child.id, child.id]);
});

test("an old child finishing behind a completed discovery sweep remains owed (#1465)", async () => {
  const fixture = childFixture("out-of-order");
  const old = fixture.spawn({ title: "slow worker", turn: "busy", host: "live" });
  fixture.spawn({ title: "fast worker", turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture).deps);
  const generation = fixture.registry.conversation(old.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "late-turn", seq: 1 });
  ledger.append(generation, { kind: "turn-ended", turnId: "late-turn", status: "completed", seq: 2 });
  const later = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, later.deps);
  expect(later.sent[0]!.text).toContain(old.id);
  expect(fixture.acknowledged()).toContain(old.id);
});

test("concurrent controllers prepare one original wake and stale state cannot overwrite its landing (#1465)", async () => {
  const fixture = childFixture("concurrent-checks");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  let release!: () => void;
  let admitted!: () => void;
  const started = new Promise<void>((resolve) => { admitted = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = childRig(fixture, { deliverWith: async () => {
    admitted(); await held;
    return { ok: true, target: "structured", outcome: "delivered", structured: true };
  } });
  const pending = runSeatTickCheck(fixture.project, first.deps);
  await started;
  const prepared = fixture.row();
  expect(prepared.outstandingWake?.text).toBe(first.sent[0]!.text);
  const second = childRig(fixture, { wakeState: "unknown" });
  await runSeatTickCheck(fixture.project, second.deps);
  expect(second.sent).toEqual([]);
  release(); await pending;
  expect(first.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(() => writeSeatTickState(fixture.project, prepared, fixture.stateFile)).toThrow("stale");
  expect(fixture.row().outstandingWake).toBeNull();
});

/* A predecessor's attempt whose fate is unknown or unverified stays the
   predecessor's attempt (#1465): a rotation is not evidence about a payload,
   so the successor is not woken over it and no wake replaces it. The wait is
   carded once it has outlived the wake interval, and only landed evidence
   settles it — acknowledging what it named exactly once. */
test("rotation and prompt changes retain an unknown predecessor wake across the deadline until proven landing (#1465)", async () => {
  const fixture = childFixture("unknown-rotation");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const first = childRig(fixture, { deliveryThrows: true, wakeState: "unknown" });
  await runSeatTickCheck(fixture.project, first.deps);
  const original = fixture.row().outstandingWake!;
  expect(original.preparedAt).toBe(new Date(fixture.now).toISOString());
  const rotated = childRig(fixture, { now: fixture.now + 61 * MINUTE,
    seat: { ...fixture.seat, seatEpoch: 8 }, wakeState: "uncertain", withdrawal: "unknown",
    settings: { ...defaultSeatTickSettings(fixture.project), monitorPrompt: "Inspect the implementation evidence." } });
  await runSeatTickCheck(fixture.project, rotated.deps);
  expect(rotated.sent).toHaveLength(0);
  expect(rotated.journal[0]).toMatchObject({ verdict: "uncertain", seatEpoch: 7, delivery: { clientMessageId: original.clientMessageId, outcome: "uncertain" } });
  expect(fixture.row().outstandingWake).toEqual(original);
  expect(fixture.row().lastWakeAt).toBe(ago(fixture, 61));
  expect(rotated.cards.map((entry) => entry.card)).toMatchObject([{ ref: SEAT_TICK_WAKE_UNRESOLVED_REF, instance: original.clientMessageId }]);
  expect(rotated.cards[0]!.card.detail).toContain("a seat that has since been replaced");
  const stillUnknown = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 }, wakeState: "unknown", withdrawal: "unknown" });
  await runSeatTickCheck(fixture.project, stillUnknown.deps);
  expect(stillUnknown.sent).toHaveLength(0);
  expect(stillUnknown.journal[0]).toMatchObject({ verdict: "revoked", delivery: { outcome: "unknown" } });
  expect(fixture.row().outstandingWake).toEqual(original);
  expect(fixture.acknowledged()).toEqual([]);
  const landed = childRig(fixture, { now: fixture.now + 183 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 }, wakeState: "landed" });
  await runSeatTickCheck(fixture.project, landed.deps);
  expect(landed.sent).toHaveLength(0);
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(fixture.row().outstandingWake).toBeNull();
});

test("first tick after rotation discovers predecessor children from committed revocations only (#1465)", async () => {
  const fixture = childFixture("predecessor-discovery");
  const old = fixture.spawn({ title: "predecessor worker", turn: "terminal" });
  const abandoned = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  fixture.spawn({ title: "abandoned pending seat worker", turn: "terminal", parent: abandoned.id });
  const successor = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  fixture.seed();
  const file = statePath("orchestrator-seats.json");
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextSeatEpoch: 9, seats: {}, pending: {},
      revocations: [{ project: fixture.project, conversationId: fixture.seat.conversationId, seatEpoch: 7,
        revokedAt: new Date(fixture.now).toISOString(), successorConversationId: successor.id }],
      history: [{ seat: { project: fixture.project, conversationId: abandoned.id, seatEpoch: 6, state: "pending" }, reason: "terminal_error" }],
    }));
    const sent: ConversationMessage[] = [];
    for (let tick = 0; tick < 5; tick++) {
      const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE, seat: { conversationId: successor.id, seatEpoch: 8, path: null } });
      await runSeatTickCheck(fixture.project, rig.deps);
      sent.push(...rig.sent);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(old.id);
    expect(fixture.acknowledged()).toEqual([old.id]);
  } finally { if (before) fs.writeFileSync(file, before); else fs.unlinkSync(file); }
});

test("a child in a deleted nested worktree keeps its parent project's harvest obligation (#1465)", async () => {
  const fixture = childFixture("deleted-worktree", true);
  const deletedCwd = path.join(fixture.cwd, ".worktrees", "finished-task");
  expect(fs.existsSync(deletedCwd)).toBe(false);
  const child = fixture.spawn({ title: "worktree worker", turn: "terminal", cwd: deletedCwd });
  fixture.seed();
  const rig = childRig(fixture);
  await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a settled child with an idle retained host is announced once and leaves no running agenda (#1465)", async () => {
  const fixture = childFixture("settled-idle-host");
  const child = fixture.spawn({ title: "settled worker", turn: "idle", host: "idle" });
  fixture.seed();
  const first = childRig(fixture);
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", items: 1 });
  expect(fixture.acknowledged()).toEqual([child.id]);
  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, second.deps)).toMatchObject({ verdict: "quiet" });
  expect(second.sent).toEqual([]);
});


test("a child inserted behind the discovery cursor is found on the next sweep after rotation (#1465)", async () => {
  const fixture = childFixture("insert-behind");
  for (let n = 0; n < 21; n++) fixture.spawn({ title: `initial ${n}`, turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture).deps);
  const added = fixture.spawn({ title: "inserted behind", turn: "terminal" });
  const db = new Database(path.join(fixture.dir, "agent-registry.sqlite"));
  db.query("UPDATE registry_rows SET row_key=? WHERE collection='lineageEdges' AND row_key=?").run("!behind", added.id);
  db.close();
  const sent: ConversationMessage[] = [];
  for (let tick = 1; tick < 18; tick++) {
    const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
    await runSeatTickCheck(fixture.project, rig.deps);
    sent.push(...rig.sent);
  }
  expect(fixture.acknowledged().filter((id) => id === added.id)).toHaveLength(1);
  expect(sent.filter((message) => message.text.includes(added.id))).toHaveLength(1);
}, 60000);

test("ambiguous legacy outcomes rotate behind later proven work and later turns remain owed (#1465)", async () => {
  const fixture = childFixture("legacy-fairness");
  const old = fixture.spawn({ title: "legacy worker", turn: "terminal" });
  const fresh = fixture.spawn({ title: "new worker", turn: "terminal" });
  fs.writeFileSync(fixture.stateFile, JSON.stringify({ version: 2, projects: { [fixture.project]: {
    ...emptySeatTickState(), seatEpoch: 7, harvestedChildren: [old.id],
    lastWakeAt: new Date(fixture.now - 61 * MINUTE).toISOString(), lastProposalAt: new Date(fixture.now).toISOString(),
  } } }));
  const first = childRig(fixture);
  await runSeatTickCheck(fixture.project, first.deps);
  expect(first.sent).toHaveLength(1);
  expect(first.sent[0]!.text).toContain(fresh.id);
  expect(first.sent[0]!.text).not.toContain(old.id);
  const generation = fixture.registry.conversation(old.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "after-migration", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "after-migration", status: "completed", seq: 4 });
  const next = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, next.deps);
  expect(next.sent).toHaveLength(1);
  expect(next.sent[0]!.text).toContain(old.id);
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  const held = accounting.collection.snapshot().filter((row) => row.kind === "outcome" && row.gap === "legacy-delivery-ambiguous");
  expect(held).toHaveLength(1);
  expect(held[0]!.kind === "outcome" && held[0]!.status).toBe("owed");
});


test("rotation after durable prepare and before transport releases the proven unsent attempt (#1465)", async () => {
  const fixture = childFixture("prepare-rotation");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const rig = childRig(fixture);
  const seatFor = rig.deps.sources!.seatFor;
  rig.deps.sources!.seatFor = (project) => fixture.row().outstandingWake
    ? { ...seatFor(project), active: null } : seatFor(project);
  await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(fixture.row().outstandingWake).toBeNull();
  expect(fixture.acknowledged()).toEqual([]);
  const successor = childRig(fixture, { seat: { ...fixture.seat, seatEpoch: 8 } });
  await runSeatTickCheck(fixture.project, successor.deps);
  expect(successor.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
});


test("successive completed turns change the retry-guard fingerprint without a sampled running state (#1465)", async () => {
  const fixture = childFixture("turn-retry-guard");
  const child = fixture.spawn({ title: "iterative worker", turn: "terminal" });
  fixture.seed();
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  for (let turn = 1; turn <= 5; turn++) {
    if (turn > 1) {
      ledger.append(generation, { kind: "turn-started", turnId: `iteration-${turn}`, seq: turn * 2 - 1 });
      ledger.append(generation, { kind: "turn-ended", turnId: `iteration-${turn}`, status: "completed", seq: turn * 2 });
    }
    const rig = childRig(fixture, { now: fixture.now + (turn - 1) * 61 * MINUTE });
    expect(await runSeatTickCheck(fixture.project, rig.deps)).toMatchObject({ verdict: "wake", items: 1 });
    expect(rig.sent).toHaveLength(1);
  }
  expect(fixture.acknowledged()).toHaveLength(5);
});


/* ------------------------------------------------------------------------- *
 * Production-shaped ledgers, fair observation, and the conditions a check
 * cannot account for (#1465, second review round).
 * ------------------------------------------------------------------------- */

/* Real child ledgers are megabytes of delta text around a handful of turn
   boundaries. The reader has to reach a child's terminal record within the
   check that follows it, not hours of thirty-kilobyte visits later. */
test("a child whose ledger is a production-sized ten megabytes of deltas is harvested by the next check (#1465)", async () => {
  const fixture = childFixture("large-ledger");
  const child = fixture.spawn({ title: "verbose worker", turn: "busy", host: "live" });
  fixture.seed();
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const lines: string[] = [JSON.stringify({ kind: "turn-started", turnId: "long-turn", seq: 1 })];
  let seq = 1;
  let bytes = 0;
  while (bytes < 10 * 1024 * 1024) {
    const line = JSON.stringify({ kind: "delta", turnId: "long-turn", text: "x".repeat(200 + (seq % 100)), seq: ++seq });
    lines.push(line);
    bytes += line.length + 1;
  }
  lines.push(JSON.stringify({ kind: "turn-ended", turnId: "long-turn", status: "completed", seq: ++seq }));
  const ledgerDir = statePath("structured-host-events");
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, `${encodeURIComponent(generation)}.jsonl`), `${lines.join("\n")}\n`);
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "verbose worker" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 1) },
    observedAt: ago(fixture, 1),
  }]);
  const started = performance.now();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  const elapsed = performance.now() - started;
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  const source = accounting.collection.snapshot().find((row) => row.kind === "source");
  // One check harvested the whole 10 MB turn; the time is reported, never asserted (#1761).
  expect(source?.kind === "source" && source.cursor).toMatchObject({ atEnd: true, seq, settledThrough: seq, gap: null });
  console.log(`[ledger] ${bytes} bytes harvested in one check in ${elapsed.toFixed(0)} ms`);
});


test("normal and proposal wakes separate operator instructions, epoch notes and legacy text", async () => {
  const at = "2026-10-01T12:00:00.000Z";
  const instructionLines = [
    { text: "Operator priority.", author: { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null }, at },
    { text: "Seat pause note.", author: { kind: "manager" as const, conversationId: "conversation_previous_seat", project: PROJECT, seatEpoch: 6 }, at },
    { text: "Operator instructions for every wake:", author: { kind: "manager" as const, conversationId: "conversation_previous_seat", project: PROJECT, seatEpoch: 6 }, at },
    { text: "Legacy note.", author: null, at: null },
  ];
  const settings = { ...promptSettings(), reason: instructionLines.map(line => line.text).join("\n"), instructionLines };
  for (const proposal of [false, true]) {
    const rig = harness({ settings, ...(proposal ? {} : { pipelines: OPEN_LANE, state: OVERDUE }) });
    await runSeatTickCheck(PROJECT, rig.deps);
    const text = rig.sent[0]!.text;
    expect(text).toContain("Operator instructions for every wake:\nOperator priority.");
    expect(text).toContain("Seat notes for every wake:\nSeat epoch 6:\n> Seat pause note.");
    expect(text).toContain("Instructions — author unknown:\n> Legacy note.");
    expect(text).toContain("> Operator instructions for every wake:");
    expect(text.match(/^Operator instructions for every wake:$/gm)).toHaveLength(1);
    expect(text.split("Operator instructions for every wake:")[1]?.split("Seat notes for every wake:")[0]).not.toContain("Seat pause note.");
  }
  const first = harness({ settings, pipelines: OPEN_LANE, state: OVERDUE });
  await runSeatTickCheck(PROJECT, first.deps);
  const otherAuthor = harness({ settings: { ...settings, instructionLines: instructionLines.map(line => line.author?.kind === "manager" ? { ...line, author: { ...line.author, seatEpoch: 5 } } : line) }, pipelines: OPEN_LANE, state: OVERDUE });
  await runSeatTickCheck(PROJECT, otherAuthor.deps);
  expect(otherAuthor.sent[0]!.clientMessageId).not.toBe(first.sent[0]!.clientMessageId);
});
