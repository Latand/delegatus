import { expect, test, spyOn, harness, PROJECT, CONVERSATION, OPEN_LANE, OVERDUE, runSeatTickCheck, fs, path, spawn, SANDBOX } from "./seatTickController.fixture";
import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import { guardedSeatTickPort, seatTickWorkSignal } from "./seatTickWork";
import type { DeadlineScheduler } from "@/lib/deadline";
import { deepFreeze } from "@/lib/deepFreeze";

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

const projectionCase = process.env.LLV_TICK_PROJECTION_CASE;
test.skipIf(!projectionCase)("retained board deadline subprocess", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE,
    tasks: Array.from({ length: 640 }, (_, index) => ({ id: `retained-${index}`, status: "done" as const })) });
  const time = clock();
  Object.assign(rig.deps, { workBudgetMs: 75_000, workClock: time.now, workScheduler: time.scheduler });
  const ports = rig.deps.sources!;
  const tasks = deepFreeze(ports.tasks()), lanes = deepFreeze(ports.pipelines());
  ports.tasks = () => tasks;
  ports.pipelines = () => lanes;
  const immediate = globalThis.setImmediate;
  let turns = 0;
  const scheduling = spyOn(globalThis, "setImmediate").mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    immediate(() => { turns++; time.advance(250); callback(...args); })) as typeof setImmediate);
  if (projectionCase === "stalled") ports.tasks = () => {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(wait, 0, 0, 1000);
  };
  try {
    process.stdout.write("\nPROJECTION_ENTERED\n");
    const result = await runSeatTickCheck(PROJECT, rig.deps);
    expect(result).toMatchObject({ verdict: "wake", delivery: { outcome: "delivered" } });
    expect(rig.sent).toHaveLength(1);
    expect(time.now()).toBeLessThan(75_000);
    expect(turns).toBeGreaterThan(0);
    expect(time.timers.size).toBe(0);
  } finally { scheduling.mockRestore(); }
});

test.skipIf(!!projectionCase).each(["delivery", "stalled"] as const)(
  "a parent supervises an owed wake with retained board rows (%s)", async mode => {
    const child = spawn(process.execPath, ["test", "--timeout=60000", import.meta.path,
      "--test-name-pattern", "^retained board deadline subprocess$"], {
      env: { ...process.env, LLV_TICK_PROJECTION_CASE: mode }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", entered = false, timedOut = false;
    const started = performance.now();
    const expire = () => { timedOut = true; child.kill("SIGKILL"); };
    let timer = setTimeout(expire, 15_000);
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-16_000); });
    child.stdout.on("data", chunk => {
      output = (output + chunk).slice(-16_000);
      if (!entered && output.includes("PROJECTION_ENTERED")) {
        entered = true;
        clearTimeout(timer);
        timer = setTimeout(expire, 5_000);
      }
    });
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      expect({ entered, timedOut, ...result, output }).toMatchObject(mode === "delivery"
        ? { entered: true, timedOut: false, code: 0, signal: null }
        : { entered: true, timedOut: true, code: null, signal: "SIGKILL" });
      expect(performance.now() - started).toBeLessThan(25_000);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

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

const dispatchRoot = process.env.LLV_DISPATCH_DEADLINE_ROOT;
const dispatchKind = process.env.LLV_DISPATCH_DEADLINE_KIND;
test.skipIf(!dispatchRoot)("real dispatch deadline subprocess", async () => {
  const { AgentRegistry, NOW, MINUTE, writeSeatTickState, emptySeatTickState, wakeStateFromRecord, resolveOriginalSend } = await import("./seatTickController.fixture");
  const { destinationWakeState } = await import("./seatTickSources");
  const registry = new AgentRegistry(path.join(dispatchRoot!, "registry.json"));
  const transcript = path.join(dispatchRoot!, "destination.jsonl");
  const conversation = registry.ensureConversation("claude", transcript, null);
  const seat = { conversationId: conversation.id, seatEpoch: 7, path: transcript };
  const stateFile = path.join(dispatchRoot!, "tick.json");
  const recovering = process.env.LLV_DISPATCH_DEADLINE_RECOVER === "1";
  if (!recovering) writeSeatTickState(PROJECT, { ...emptySeatTickState(), ...OVERDUE, seatEpoch: 7 }, stateFile);
  const release = deferred();
  const onRelease = () => release.resolve();
  process.stdin.once("data", onRelease);
  const rig = harness({ pipelines: OPEN_LANE, stateFile, seat, now: NOW + (recovering ? 20 * MINUTE : 0),
    deliverWith: recovering ? undefined : async message => {
      process.stdout.write("\nDISPATCH_ENTERED\n");
      await release.promise;
      if (dispatchKind === "throw") throw new Error("transport disconnected");
      if (dispatchKind === "operation") {
        const held = registry.holdDelivery(conversation.id as never, message.text, message.clientMessageId!, "text", [], null,
          { operationId: "late-operation", kind: "send", policy: "queue" });
        registry.recordDeliveryOutcome(held.id, "failed", "late operation ended without arrival", "unverified");
        return { ok: true, outcome: "queued", operationId: "late-operation", target: null };
      }
      return dispatchKind === "uncertain"
        ? { ok: false, outcome: "failed", status: 503, error: "arrival unknown", actuation: "started", resend: "verify-first" }
        : { ok: false, outcome: "failed", status: 503, error: "refused before reservation", admission: "refused" };
    } });
  rig.deps.sources!.wakeState = pending => wakeStateFromRecord(pending, {
    lookup: binding => resolveOriginalSend(binding, { registry, client: null }),
    destination: pending => destinationWakeState(pending, registry),
    journal: async () => ({ status: "uncertain", reason: "late operation ended without arrival" }),
  });
  rig.deps.workBudgetMs = 2_000;
  try {
    if (!recovering) {
      const result = await runSeatTickCheck(PROJECT, rig.deps);
      expect(result).toMatchObject({ verdict: "error" });
      expect(result?.detail).toContain("deadline");
      process.stdout.write("\nDISPATCH_DEADLINE\n");
      await release.promise;
      // The parent supervises this process even if a synchronous write blocks it.
      while (rig.deps.readState!(PROJECT).outstandingWake?.dispatch?.state === "active") await Bun.sleep(1);
      const wake = rig.deps.readState!(PROJECT).outstandingWake!;
      expect(wake.dispatch?.state).toBe(dispatchKind === "refusal" ? "refused" : "returned");
      expect(wake.operationId).toBe(dispatchKind === "operation" ? "late-operation" : null);
      if (dispatchKind !== "operation") expect(wake.dispatch?.reason).toContain(dispatchKind === "throw" ? "transport disconnected"
        : dispatchKind === "uncertain" ? "arrival unknown" : dispatchKind === "refusal" ? "refused before reservation" : "queued");
      if (dispatchKind === "uncertain") expect(wake.dispatch?.uncertain).toBe(true);
    } else {
      const before = rig.deps.readState!(PROJECT);
      expect(before.outstandingWake).not.toBeNull();
      expect(before.lastWakeAt).toBe(OVERDUE.lastWakeAt);
      const originalKey = before.outstandingWake!.clientMessageId;
      for (let check = 0; check < 2; check++) await runSeatTickCheck(PROJECT, rig.deps);
      expect(rig.sent).toHaveLength(1);
      if (dispatchKind === "refusal") expect(rig.sent[0]!.clientMessageId).toBe(originalKey);
      else expect(rig.sent[0]!.clientMessageId).not.toBe(originalKey);
      expect(rig.deps.readState!(PROJECT).seatEpoch).toBe(7);
      expect(rig.deps.readState!(PROJECT).outstandingWake).toBeNull();
      if (dispatchKind !== "refusal") expect(rig.journal.some(record => record.delivery?.clientMessageId === originalKey && record.verdict === "dropped")).toBe(true);
    }
  } finally { release.resolve(); process.stdin.off("data", onRelease); process.stdin.destroy(); }
});

test.skipIf(!!dispatchRoot).each(["refusal", "operation", "throw", "uncertain"] as const)(
  "a parent supervises real dispatch expiry and a fresh process recovers (%s)", async kind => {
    const root = fs.mkdtempSync(path.join(SANDBOX, "dispatch-deadline-"));
    fs.writeFileSync(path.join(root, "destination.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "unrelated input" } }) + "\n");
    for (const recovering of [false, true]) {
      const child = spawn(process.execPath, ["test", "--timeout=60000", import.meta.path, "--test-name-pattern", "^real dispatch deadline subprocess$"], {
        env: { ...process.env, LLV_DISPATCH_DEADLINE_ROOT: root, LLV_DISPATCH_DEADLINE_KIND: kind,
          LLV_DISPATCH_DEADLINE_RECOVER: recovering ? "1" : "0" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "", timedOut = false, entered = 0, expired = 0;
      child.stderr.on("data", chunk => { output = (output + chunk).slice(-16_000); });
      let timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
      let control = "";
      child.stdout.on("data", chunk => {
        output = (output + chunk).slice(-16_000);
        control += chunk;
        if (!entered && control.includes("DISPATCH_ENTERED")) {
          entered++;
          clearTimeout(timer);
          timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000);
        }
        if (!expired && control.includes("DISPATCH_DEADLINE")) { expired++; child.stdin.end("release"); }
      });
      try {
        const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
        expect({ code, timedOut, output }).toMatchObject({ code: 0, timedOut: false });
        expect(entered).toBe(recovering ? 0 : 1);
        expect(expired).toBe(recovering ? 0 : 1);
      } finally { clearTimeout(timer); }
    }
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


for (const source of ["skipped", "failed"] as const) test(`a ${source} forms read is explicit in a landed controller wake`, async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  rig.deps.sources!.workerAsks = async () => { if (source === "failed") throw new Error("fixture source failed"); return null; };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).toContain("Open decision forms: not read this check");
  expect(rig.sent[0]!.text).not.toContain("Open decision forms: 0");
});

test("the controller forwards the active seat identity through the ordinary form gather", async () => {
  const { NOW } = await import("./seatTickController.fixture");
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const ids: (string | undefined)[] = [];
  rig.deps.sources!.workerAsks = async (_project, seatConversationId) => {
    ids.push(seatConversationId);
    return { asks: [], forms: { count: 1, rows: [{ id: "prototype:previous-seat", kind: "prototype", title: "Choose",
      line: "Choose", since: new Date(NOW - 86_400_000).toISOString(), taskId: null, subject: { reviewId: "previous-seat" },
      target: null, stale: false, evidence: [{ code: "earlier-seat", stale: false, detail: "a previous seat epoch asked this", at: null, source: "seat-notices" }] }] } };
  };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(ids).toContain(CONVERSATION);
  expect(rig.sent[0]!.text).toContain("earlier-seat");
});

test("form pages rotate only after complete rows land, and carry exact withdrawal identities", async () => {
  const { NOW, MINUTE } = await import("./seatTickController.fixture");
  const { readSeatTickState } = await import("./seatTickState");
  const forms = { count: 11, routedToSeat: 2, rows: Array.from({ length: 11 }, (_, n) => ({ id: `prototype:round-${String(n).padStart(2, "0")}`, kind: "prototype" as const,
    title: `Choice ${n}`, line: "Choose a direction", since: new Date(NOW - 86_400_000).toISOString(), taskId: null,
    subject: { reviewId: `round-${String(n).padStart(2, "0")}` }, target: null, stale: n === 0,
    evidence: n === 0 ? [{ code: "lane-moved-past", stale: true, at: null, detail: "The lane moved on", source: "pipelines" }] : [],
  })) };
  const file = path.join(SANDBOX, "form-pages.json");
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE, stateFile: file, now: NOW, delivery: { ok: false, outcome: "failed", error: "fixture refusal", status: 503 } });
  first.deps.sources!.workerAsks = async () => ({ asks: [], forms });
  await runSeatTickCheck(PROJECT, first.deps);
  expect(first.sent[0]!.text).toContain("STALE: lane-moved-past");
  expect(first.sent[0]!.text).toContain('target {kind:"prototype", taskId, reviewId}');
  expect(readSeatTickState(PROJECT, file).formPageAfter).toBeUndefined();
  const second = harness({ pipelines: OPEN_LANE, stateFile: file, now: NOW + 60 * MINUTE, wakeState: "absent" });
  second.deps.sources!.workerAsks = async () => ({ asks: [], forms });
  await runSeatTickCheck(PROJECT, second.deps);
  const after = readSeatTickState(PROJECT, file).formPageAfter;
  expect(after).toBeTruthy();
  const third = harness({ pipelines: OPEN_LANE, stateFile: file, now: NOW + 120 * MINUTE });
  third.deps.sources!.workerAsks = async () => ({ asks: [], forms });
  await runSeatTickCheck(PROJECT, third.deps);
  const next = forms.rows.findIndex(row => row.id === after) + 1;
  expect(third.sent[0]!.text).toContain(`- prototype ${forms.rows[next]!.subject.reviewId} |`);
  expect(third.sent[0]!.text).not.toContain("- prototype round-00 |");
});


test("a decided form with failed delivery is identified as answered in the controller wake", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  rig.deps.sources!.workerAsks = async () => ({ asks: [], forms: { count: 1, rows: [{ id: "prototype:answered-round", kind: "prototype", title: "Saved choice", line: "Delivery needs attention", since: "2026-08-27T12:00:00Z", taskId: null,
    subject: { reviewId: "answered-round" }, target: null, stale: false, evidence: [{ code: "undelivered", stale: false, at: null, detail: "The saved answer has not arrived", source: "tasks" }] }] } });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent[0]!.text).toContain("answered; delivery pending");
});


for (const delivered of [false, true]) test(`proposal wakes carry forms and credit only delivery: ${delivered}`, async () => {
  const { readSeatTickState } = await import("./seatTickState");
  const file = path.join(SANDBOX, `proposal-form-${delivered}.json`);
  const rig = harness({ pipelines: [], tasks: [], state: { ...OVERDUE, lastProposalAt: null }, stateFile: file,
    ...(delivered ? {} : { delivery: { ok: false, outcome: "failed" as const, error: "fixture refusal", status: 503 } }) });
  rig.deps.sources!.workerAsks = async () => ({ asks: [], forms: { count: 1, rows: [{ id: "prototype:proposal-choice", kind: "prototype", title: "Choose a direction", line: "Choose", since: "2026-08-26T12:00:00Z", taskId: null,
    subject: { reviewId: "proposal-choice" }, target: null, stale: false, evidence: [] }] } });
  const result = await runSeatTickCheck(PROJECT, rig.deps);
  expect(result?.verdict).toBe("proactive");
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).toContain("- prototype proposal-choice |");
  expect(readSeatTickState(PROJECT, file).formPageAfter).toBe(delivered ? "prototype:proposal-choice" : undefined);
});
