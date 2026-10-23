import { expect, test, harness, PROJECT, CONVERSATION, RECENT, OVERDUE,
  OPEN_LANE, pipelineRecord, fs, path, spawn, spyOn, SANDBOX, readSeatTickState, writeSeatTickState, emptySeatTickState, NOW,
  runSeatTickCheck, reconcileSeatTick, startSeatTick, stopSeatTick, DEFAULT_SEAT_TICK_POLICY } from "./seatTickController.fixture";
import type { DeliveryOutcome } from "@/lib/delivery";
import type { DeadlineScheduler } from "@/lib/deadline";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function virtualClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const scheduler: DeadlineScheduler = {
    setTimeout: (run, delay) => { const id = ++next; timers.set(id, { at: now + delay, run }); return id; },
    clearTimeout: handle => { timers.delete(handle as number); },
  };
  return { now: () => now, scheduler, advance: (delta: number) => {
    now += delta;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); }
  }, timers };
}

function deployRig() {
  const rig = harness({ state: RECENT, seatDeployments: [{ deploymentId: "deploy-own", conversationId: CONVERSATION }],
    deployments: { "deploy-own": { phase: "succeeded", terminal: true, revision: "a".repeat(40) } },
    delivery: { ok: true, target: "structured", outcome: "delivered", spawned: true, structured: true } });
  rig.deps.sources!.liveness = async () => [{ conversationId: CONVERSATION,
    host: { state: "gone", kind: "structured", pid: null }, reason: "host_gone_turn_settled", turnState: "idle" } as never];
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "stdio host gone" });
  return rig;
}

test("a deploy settling during an overlong pass revives its gone seat before one interval", async () => {
  const rig = deployRig();
  const clock = virtualClock();
  const settlement = rig.deps.sources!.deployment!;
  let settled = false;
  rig.deps.sources!.deployment = id => settled ? settlement(id) : { state: "unreadable", error: "still promoting" } as never;
  const preparation = deferred();
  const entered = deferred();
  rig.deps.sources!.prepareRead = async () => { entered.resolve(); await preparation.promise; };
  rig.deps.ownsTraffic = () => true;
  rig.deps.recordSuccessions = () => [];
  rig.deps.workClock = clock.now;
  rig.deps.workScheduler = clock.scheduler;
  rig.deps.release = rig.deps.curation = rig.deps.maintenance = null;
  let callback!: () => void;
  let pollMs = 0;
  const longPass = deferred();
  const delivered = deferred();
  const append = rig.deps.appendRecord!;
  rig.deps.appendRecord = record => { append(record); if (record.verdict === "wake") delivered.resolve(); };
  const logs: string[] = [];
  let passes = 0;
  let latestCheck: ReturnType<typeof reconcileSeatTick> | undefined;
  startSeatTick({ clock: clock.now, policy: DEFAULT_SEAT_TICK_POLICY, recordSuccessions: () => [],
    handoffHeld: () => false, drainHeld: () => false,
    scheduleInterval: (run, delay) => { callback = run; pollMs = delay; return { unref() {} } as never; },
    sweep: async () => { const first = ++passes === 1; latestCheck = reconcileSeatTick(rig.deps); await latestCheck; if (first) await longPass.promise; },
    log: line => logs.push(line), appendRecord: () => {} });
  try {
    await entered.promise;
    clock.advance(DEFAULT_SEAT_TICK_POLICY.checkIntervalMs * 1.25);
    // Let the expired project unwind; the first pass stays open independently.
    await new Promise<void>(resolve => setImmediate(resolve));
    settled = true;
    const settledAt = clock.now();
    clock.advance(pollMs);
    callback();
    await delivered.promise;
    await latestCheck;
    expect(clock.now()).toBeGreaterThan(DEFAULT_SEAT_TICK_POLICY.checkIntervalMs);
    expect(clock.now() - settledAt).toBeLessThan(DEFAULT_SEAT_TICK_POLICY.checkIntervalMs);
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0]!.text).toContain("deploy settled");
    expect(logs.some(line => line.includes("sweep-running") && line.includes("ageMs=") && line.includes("state=long-running"))).toBe(true);
  } finally { stopSeatTick(); preparation.resolve(); longPass.resolve(); }
});

test("one project's deadline and late preparation cannot starve or overwrite another deploy", async () => {
  const rig = deployRig();
  const clock = virtualClock();
  const entered = deferred(), preparation = deferred();
  rig.deps.sources!.prepareRead = async () => { entered.resolve(); await preparation.promise; };
  const seatFor = rig.deps.sources!.seatFor;
  rig.deps.sources!.activeSeats = () => ["a-slow", PROJECT];
  rig.deps.sources!.seatFor = project => project === PROJECT ? seatFor(project) : { active: null, pending: null, history: [] };
  Object.assign(rig.deps, { ownsTraffic: () => true, recordSuccessions: () => [],
    workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 100,
    curation: null, release: null, maintenance: null });
  const delivered = deferred();
  const append = rig.deps.appendRecord!;
  rig.deps.appendRecord = record => { append(record); if (record.verdict === "wake") delivered.resolve(); };
  const sweep = reconcileSeatTick(rig.deps);
  try {
    await entered.promise;
    await delivered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(rig.sent).toHaveLength(1);
    clock.advance(100);
    const records = await sweep;
    expect(records.find(record => record.project === "a-slow")).toMatchObject({ verdict: "error" });
    expect(records.find(record => record.project === "a-slow")!.detail).toContain("phase=check.sources.prepareRead");
    const writes = rig.written.length;
    preparation.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(rig.written).toHaveLength(writes);
    expect(rig.sent).toHaveLength(1);
  } finally { preparation.resolve(); await sweep; }
});

test("callbacks during one project check coalesce one owed check with fresh state", async () => {
  const rig = deployRig();
  const preparing = deferred(), entered = deferred(), finished = deferred();
  let preparations = 0, checks = 0;
  const settlement = rig.deps.sources!.deployment!;
  let settled = false;
  rig.deps.sources!.deployment = id => settled ? settlement(id) : { state: "unreadable", error: "still promoting" } as never;
  rig.deps.sources!.prepareRead = async () => {
    if (++preparations === 1) { entered.resolve(); await preparing.promise; }
  };
  Object.assign(rig.deps, { ownsTraffic: () => true, recordSuccessions: () => [],
    workStarted: () => { checks++; }, curation: null, release: null, maintenance: null });
  const append = rig.deps.appendRecord!;
  rig.deps.appendRecord = record => { append(record); if (checks === 2) finished.resolve(); };
  const first = reconcileSeatTick(rig.deps);
  try {
    await entered.promise;
    const second = reconcileSeatTick(rig.deps), third = reconcileSeatTick(rig.deps);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(checks).toBe(1);
    settled = true;
    preparing.resolve();
    await Promise.all([first, second, third]);
    await finished.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(checks).toBe(2);
    expect(rig.sent).toHaveLength(1);
    expect(rig.deps.readState!(PROJECT).announcedDeploys).toEqual(["deploy-own"]);
  } finally { preparing.resolve(); await first; stopSeatTick(); }
});

test("an alarm-sources cancellation is retried immediately and a newly settled deploy lands", async () => {
  const { deepFreeze } = await import("@/lib/deepFreeze");
  const { performanceSpans } = await import("@/lib/performanceSpans");
  const rig = deployRig();
  const settlement = rig.deps.sources!.deployment!;
  let settled = false;
  rig.deps.sources!.deployment = id => settled ? settlement(id) : { state: "unreadable", error: "still promoting" } as never;
  let rows = deepFreeze(Array.from({ length: 8 }, (_, index) => pipelineRecord({ ...OPEN_LANE[0]!, id: `evidence-${index}` })));
  rig.deps.sources!.pipelines = () => rows as never;
  const sync = performanceSpans.sync;
  let scheduled = false;
  const observe: typeof sync = (site, read, ...rest) => {
    const result = sync(site, read, ...rest);
    if (site === "seat-tick.hash" && !scheduled) {
      scheduled = true;
      // Publish during the real provenance hash's cooperative yield.
      setImmediate(() => {
        rows = deepFreeze(rows.map(row => ({ ...row, task: "replacement evidence" })));
        settled = true;
      });
    }
    return result;
  };
  const hashing = spyOn(performanceSpans, "sync").mockImplementation(observe);
  try {
    const result = await runSeatTickCheck(PROJECT, rig.deps);
    expect(scheduled).toBe(true);
    expect(rig.journal.some(record => record.detail?.includes("Seat alarm sources changed"))).toBe(true);
    expect(result).toMatchObject({ verdict: "wake", reasons: ["deploy-settled"], delivery: { outcome: "delivered" } });
    expect(rig.sent).toHaveLength(1);
    expect(rig.deps.readState!(PROJECT).announcedDeploys).toEqual(["deploy-own"]);
  } finally { hashing.mockRestore(); }
});

test("a priority deploy preserves opening problem credit before epoch reset", async () => {
  const rig = deployRig();
  const before = rig.deps.readState!(PROJECT);
  rig.deps.writeState!(PROJECT, { ...before, seatEpoch: 6, itemsShown: ["opening-problem"] });
  const calls: string[] = [];
  rig.deps.sources!.prepareRead = async () => { throw new Error("general history must not delay the deploy"); };
  rig.deps.sources!.prepareMemoryProblems = async () => { calls.push("prepared"); };
  rig.deps.sources!.memoryProblems = (_project, shown) => { calls.push(...shown); return []; };
  expect((await runSeatTickCheck(PROJECT, rig.deps))?.delivery?.outcome).toBe("delivered");
  expect(calls).toEqual(["prepared", "opening-problem"]);
  expect(rig.sent).toHaveLength(1);
});

test("release authority lost during a deploy check fences dispatch", async () => {
  const rig = deployRig();
  const read = rig.deps.sources!.liveness;
  let ownsTraffic = true;
  rig.deps.ownsTraffic = () => ownsTraffic;
  rig.deps.sources!.liveness = async request => { ownsTraffic = false; return read(request); };
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(0);
  expect(record?.detail).toContain("viewer-release-replaced");
  expect(rig.deps.readState!(PROJECT).announcedDeploys ?? []).toEqual([]);
});

test("an expired transport continuation keeps its original outstanding key and never credits a late answer", async () => {
  const clock = virtualClock();
  const entered = deferred(), transport = deferred<DeliveryOutcome>();
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE,
    deliverWith: async () => { entered.resolve(); return transport.promise; } });
  Object.assign(rig.deps, { workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 100 });
  const checking = runSeatTickCheck(PROJECT, rig.deps);
  await entered.promise;
  clock.advance(100);
  const result = await checking;
  expect(result?.verdict).toBe("error");
  expect(result?.detail).toContain("deadline");
  const saved = rig.deps.readState!(PROJECT);
  const key = saved.outstandingWake?.clientMessageId;
  expect(key ?? null).toBe(rig.sent[0]?.clientMessageId ?? null);
  expect(saved.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(clock.timers.size).toBe(0);
  const writes = rig.written.length;
  transport.resolve({ ok: true, target: "structured", outcome: "delivered" });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(rig.written).toHaveLength(writes);
});


test("the project deadline reaches the production liveness reader", async () => {
  const liveness = await import("@/lib/lifecycle/liveness");
  const { defaultSeatTickAdmissionSources } = await import("./seatTickAdmissionSources");
  const clock = virtualClock(), entered = deferred();
  let signal: AbortSignal | undefined;
  const snapshot = spyOn(liveness, "agentLivenessSnapshot").mockImplementation(async request => {
    signal = request.signal ?? undefined;
    entered.resolve();
    await new Promise<void>((_, reject) => request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true }));
    return { conversations: [] } as never;
  });
  try {
    const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
    rig.deps.sources!.liveness = defaultSeatTickAdmissionSources().liveness;
    Object.assign(rig.deps, { workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 100 });
    const checking = runSeatTickCheck(PROJECT, rig.deps);
    await entered.promise;
    expect(signal?.aborted).toBe(false);
    clock.advance(100);
    expect((await checking)?.verdict).toBe("error");
    expect(signal?.aborted).toBe(true);
  } finally { snapshot.mockRestore(); }
});

const childMode = process.env.LLV_SEAT_DEADLINE_TEST_MODE;
test.skipIf(!childMode)("seat deadline subprocess case", async () => {
  const filename = process.env.LLV_SEAT_DEADLINE_TEST_STATE!;
  if (childMode === "expire") writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, filename);
  const rig = harness({ pipelines: OPEN_LANE, stateFile: filename, wakeState: "landed",
    ...(childMode === "expire" ? { deliverWith: async () => {
      process.stdout.write("DEADLINE_READY\n");
      return new Promise<DeliveryOutcome>(() => {});
    } } : {}) });
  rig.deps.workBudgetMs = 1000;
  if (childMode === "recover") {
    const key = readSeatTickState(PROJECT, filename).outstandingWake?.clientMessageId;
    expect(typeof key).toBe("string");
    rig.deps.sources!.wakeState = async wake => { expect(wake.clientMessageId).toBe(key!); return "landed"; };
  }
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  const state = readSeatTickState(PROJECT, filename);
  if (childMode === "expire") {
    expect(record?.verdict).toBe("error");
    expect(record?.detail).toContain("deadline exceeded");
    expect(state.outstandingWake?.clientMessageId ?? null).toBe(rig.sent[0]?.clientMessageId ?? null);
    expect(state.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  } else {
    expect(state.outstandingWake).toBeNull();
    expect(state.lastWakeAt).toBe(new Date(NOW).toISOString());
    expect(rig.sent).toHaveLength(0);
  }
  process.stdout.write(`DEADLINE_DONE:${childMode}\n`);
});

test.skipIf(!!childMode)("a deadline in a real process preserves the wake for the restarted controller", async () => {
  const filename = path.join(fs.mkdtempSync(path.join(SANDBOX, "deadline-process-")), "state.json");
  for (const mode of ["expire", "recover"]) {
    const child = spawn(process.execPath, ["test", import.meta.path, "--test-name-pattern", "seat deadline subprocess case"], {
      env: { ...process.env, LLV_SEAT_DEADLINE_TEST_MODE: mode, LLV_SEAT_DEADLINE_TEST_STATE: filename }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { errors += chunk.toString(); });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("exit", resolve);
      });
      expect({ code, errors }).toMatchObject({ code: 0 });
      expect(output).toContain(`DEADLINE_DONE:${mode}`);
      if (mode === "expire") expect(output).toContain("DEADLINE_READY");
    } finally { clearTimeout(timeout); child.stdin.end(); }
  }
});
