import { expect, test, harness, PROJECT, OPEN_LANE, OVERDUE, runSeatTickCheck, fs, path, spawn, SANDBOX } from "./seatTickController.fixture";
import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import { guardedSeatTickPort, seatTickWorkSignal } from "./seatTickWork";
import type { DeadlineScheduler } from "@/lib/deadline";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function clock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const scheduler: DeadlineScheduler = {
    setTimeout: (run, delay) => { const id = ++next; timers.set(id, { at: now + delay, run }); return id; },
    clearTimeout: id => { timers.delete(id as number); },
  };
  return { now: () => now, scheduler, timers, advance: (delta: number) => {
    now += delta;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); }
  } };
}

test.each(["liveness", "workerAsks", "recordRuleReports"] as const)(
  "a slow %s yields its share and the owed wake still lands", async source => {
    const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
    const time = clock(), entered = deferred(), release = deferred();
    Object.assign(rig.deps, { workBudgetMs: 800, workClock: time.now, workScheduler: time.scheduler });
    let reads = 0, signal: AbortSignal | undefined, lateWrites = 0;
    const late = deferred();
    const slow = async (): Promise<[]> => {
      reads++;
      signal = seatTickWorkSignal();
      entered.resolve();
      await release.promise;
      try { guardedSeatTickPort({ write: () => { lateWrites++; } }, "late").write(); }
      catch { /* The expired source's scope must refuse its continuation. */ }
      late.resolve();
      return [];
    };
    if (source === "recordRuleReports") rig.deps.sources!.recordRuleReports = async () => { await slow(); };
    else rig.deps.sources![source] = slow;
    const checking = runSeatTickCheck(PROJECT, rig.deps);
    try {
      await entered.promise;
      time.advance(100);
      expect(signal?.aborted).toBe(true);
      const result = await checking;
      expect(result).toMatchObject({ verdict: "wake", delivery: { outcome: "delivered" } });
      expect(rig.sent).toHaveLength(1);
      expect(rig.sent[0]!.text).toContain(`Skipped sources (budget): ${source}`);
      expect(result?.detail).toContain(source);
      expect(time.now()).toBeLessThan(800);
      expect(reads).toBe(1);
      expect(time.timers.size).toBe(0);
      release.resolve();
      await late.promise;
      expect(lateWrites).toBe(0);
    } finally { release.resolve(); await checking; }
  });

test("a repeatedly overflowing source leaves other sources a turn on every check", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const time = clock();
  Object.assign(rig.deps, { workBudgetMs: 800, workClock: time.now, workScheduler: time.scheduler });
  const release = deferred();
  let entered = deferred(), asks = 0, reports = 0, reads = 0, signal: AbortSignal | undefined;
  let checking: ReturnType<typeof runSeatTickCheck> | undefined;
  rig.deps.sources!.liveness = async () => { reads++; signal = seatTickWorkSignal(); entered.resolve(); await release.promise; return []; };
  rig.deps.sources!.workerAsks = async () => { asks++; return []; };
  rig.deps.sources!.recordRuleReports = async () => { reports++; };
  try {
    for (let check = 1; check <= 3; check++) {
      entered = deferred();
      rig.deps.writeState!(PROJECT, { ...rig.deps.readState!(PROJECT), ...OVERDUE });
      checking = runSeatTickCheck(PROJECT, rig.deps);
      await entered.promise;
      time.advance(100);
      expect(signal?.aborted).toBe(true);
      expect((await checking)?.verdict).toBe("wake");
      expect(reads).toBe(check);
      expect(asks).toBe(check);
      expect(reports).toBe(check);
      expect(rig.sent).toHaveLength(check);
      expect(time.timers.size).toBe(0);
    }
  } finally { release.resolve(); time.advance(800); await checking; }
});

test("repeated liveness calls share one allocation within a check", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, turn: "busy" });
  const time = clock(), entered = deferred(), release = deferred();
  Object.assign(rig.deps, { workBudgetMs: 800, workClock: time.now, workScheduler: time.scheduler });
  let reads = 0, signal: AbortSignal | undefined;
  rig.deps.sources!.liveness = async () => {
    if (++reads === 1) { time.advance(70); return []; }
    signal = seatTickWorkSignal();
    entered.resolve();
    await release.promise;
    return [];
  };
  const checking = runSeatTickCheck(PROJECT, rig.deps);
  try {
    await entered.promise;
    time.advance(30);
    expect(signal?.aborted).toBe(true);
    expect((await checking)?.verdict).toBe("wake");
    expect(reads).toBe(2);
    expect(time.now()).toBe(100);
  } finally { release.resolve(); time.advance(800); await checking; }
});

test("an expired source cannot write while the rest of its check is still running", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const time = clock(), livenessEntered = deferred(), asksEntered = deferred();
  const releaseLiveness = deferred(), releaseAsks = deferred(), lateFinished = deferred();
  Object.assign(rig.deps, { workBudgetMs: 800, workClock: time.now, workScheduler: time.scheduler });
  let writes = 0, refused = false, signal: AbortSignal | undefined;
  rig.deps.sources!.liveness = async () => {
    signal = seatTickWorkSignal();
    livenessEntered.resolve();
    await releaseLiveness.promise;
    try { guardedSeatTickPort({ write: () => { writes++; } }, "late").write(); }
    catch { refused = true; }
    lateFinished.resolve();
    return [];
  };
  rig.deps.sources!.workerAsks = async () => { asksEntered.resolve(); await releaseAsks.promise; return []; };
  const checking = runSeatTickCheck(PROJECT, rig.deps);
  try {
    await livenessEntered.promise;
    time.advance(100);
    expect(signal?.aborted).toBe(true);
    await asksEntered.promise;
    releaseLiveness.resolve();
    await lateFinished.promise;
    expect(refused).toBe(true);
    expect(writes).toBe(0);
    expect(rig.sent).toHaveLength(0);
    releaseAsks.resolve();
    expect((await checking)?.delivery?.outcome).toBe("delivered");
  } finally { releaseLiveness.resolve(); releaseAsks.resolve(); time.advance(800); await checking; }
});

test.each(["liveness", "workerAsks", "recordRuleReports"] as const)("a fast %s retains its result without a skipped diagnostic", async source => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  let reads = 0;
  const read = async (): Promise<[]> => { reads++; return []; };
  if (source === "recordRuleReports") rig.deps.sources!.recordRuleReports = async () => { await read(); };
  else rig.deps.sources![source] = read;
  const result = await runSeatTickCheck(PROJECT, rig.deps);
  expect(result?.verdict).toBe("wake");
  expect(reads).toBeGreaterThan(0);
  expect(rig.sent[0]!.text).not.toContain("Skipped sources");
});

test.each(["once", "always", "unrelated"] as const)("preparation read conflicts retry once: %s", async mode => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  let reads = 0;
  rig.deps.sources!.prepareRead = async () => {
    reads++;
    if (mode === "unrelated") throw new Error("preparation unavailable");
    if (mode === "always" || reads === 1) throw new StateSnapshotChangedError();
  };
  const result = await runSeatTickCheck(PROJECT, rig.deps);
  if (mode === "once") {
    expect(result?.verdict).toBe("wake");
    // Opening preparation, retry, then the gather's preparation.
    expect(reads).toBe(3);
    expect(rig.sent).toHaveLength(1);
  } else {
    expect(result?.verdict).toBe("error");
    expect(reads).toBe(mode === "always" ? 2 : 1);
    expect(rig.sent).toHaveLength(0);
    expect(result?.detail).toContain(mode === "always" ? "controller snapshot changed" : "preparation unavailable");
  }
});

const restartFile = process.env.LLV_SOURCE_SHARE_RESTART_FILE;
test.skipIf(!restartFile)("source share subprocess case", async () => {
  const rig = harness({ pipelines: OPEN_LANE, stateFile: restartFile });
  rig.deps.writeState!(PROJECT, { ...rig.deps.readState!(PROJECT), ...OVERDUE });
  const time = clock(), entered = deferred(), release = deferred();
  Object.assign(rig.deps, { workBudgetMs: 800, workClock: time.now, workScheduler: time.scheduler });
  let reads = 0, signal: AbortSignal | undefined;
  rig.deps.sources!.liveness = async () => { reads++; signal = seatTickWorkSignal(); entered.resolve(); await release.promise; return []; };
  const checking = runSeatTickCheck(PROJECT, rig.deps);
  try {
    await entered.promise;
    time.advance(100);
    expect(signal?.aborted).toBe(true);
    expect((await checking)?.delivery?.outcome).toBe("delivered");
    expect(reads).toBe(1);
    expect(rig.sent).toHaveLength(1);
    expect(time.timers.size).toBe(0);
  } finally { release.resolve(); time.advance(800); await checking; }
});

test.skipIf(!!restartFile)("a restarted controller gives the slow source a fresh share and still wakes", async () => {
  const filename = path.join(fs.mkdtempSync(path.join(SANDBOX, "source-share-restart-")), "state.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawn(process.execPath, ["test", import.meta.path, "--test-name-pattern", "^source share subprocess case$"], {
      env: { ...process.env, LLV_SOURCE_SHARE_RESTART_FILE: filename }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      expect({ code, output }).toMatchObject({ code: 0 });
    } finally { clearTimeout(timer); }
  }
});

test("a fast optional report admission refusal leaves a source gap and still delivers", async () => {
  const { StateLockDeferredError } = await import("@/lib/state/lockWait");
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  rig.deps.sources!.recordRuleReports = () => { throw new StateLockDeferredError("state.lease.sqlite"); };
  const result = await runSeatTickCheck(PROJECT, rig.deps);
  expect(result?.verdict).toBe("wake");
  expect(rig.sent).toHaveLength(1);
  expect(result?.detail).toContain("recordRuleReports");
});

test.each(["refusal", "operation", "throw", "uncertain"] as const)("dispatch return survives the check deadline (%s)", async kind => {
  const entered = deferred(), release = deferred();
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, deliverWith: async () => {
    entered.resolve(); await release.promise;
    if (kind === "throw") throw new Error("transport disconnected");
    return kind === "uncertain" ? { ok: false, outcome: "failed", status: 503, error: "arrival unknown", actuation: "started", resend: "verify-first" }
      : kind === "operation" ? { ok: true, outcome: "queued", operationId: "late-operation", target: null }
      : { ok: false, outcome: "failed", status: 503, error: "refused before reservation", admission: "refused" };
  } });
  const time = clock();
  Object.assign(rig.deps, { workBudgetMs: 800, workClock: time.now, workScheduler: time.scheduler });
  const checking = runSeatTickCheck(PROJECT, rig.deps);
  try {
    await entered.promise;
    time.advance(800);
    expect((await checking)?.verdict).toBe("error");
    release.resolve();
    const timeout = performance.now() + 5_000;
    while (rig.deps.readState!(PROJECT).outstandingWake?.dispatch?.state === "active") {
      if (performance.now() >= timeout) throw new Error("return bookkeeping did not finish");
      await Bun.sleep(1);
    }
    const wake = rig.deps.readState!(PROJECT).outstandingWake!;
    expect(wake.dispatch?.state).toBe(kind === "refusal" ? "refused" : "returned");
    expect(wake.operationId).toBe(kind === "operation" ? "late-operation" : null);
    if (kind === "throw") expect(wake.dispatch?.reason).toContain("transport disconnected");
    if (kind === "uncertain") expect(wake.dispatch?.uncertain).toBe(true);
  } finally { release.resolve(); await checking; }
});

test("dispatch receipt bookkeeping retries an admission failure without losing the operation", async () => {
  const { spyOn } = await import("bun:test");
  const { SeatTickAccounting } = await import("./seatTickAccounting");
  const { StateLockDeferredError } = await import("@/lib/state/lockWait");
  const original = SeatTickAccounting.prototype.returnedDispatch;
  let calls = 0;
  const save = spyOn(SeatTickAccounting.prototype, "returnedDispatch").mockImplementation(function (this: InstanceType<typeof SeatTickAccounting>, ...args: Parameters<typeof original>) {
    if (++calls === 1) throw new StateLockDeferredError("state.lease.sqlite");
    return Reflect.apply(original, this, args);
  });
  try {
    const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, delivery: { ok: true, outcome: "queued", operationId: "saved-operation", target: null } });
    expect((await runSeatTickCheck(PROJECT, rig.deps))?.delivery?.outcome).toBe("queued");
    expect(calls).toBeGreaterThan(1);
    expect(rig.deps.readState!(PROJECT).outstandingWake).toMatchObject({ operationId: "saved-operation", dispatch: { state: "returned" } });
    expect(rig.sent).toHaveLength(1);
  } finally { save.mockRestore(); }
});
