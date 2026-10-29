import { expect, test, fs, path, spawn, SANDBOX, runSeatTickCheck, SeatTickAccounting, AgentRegistry,
  PROJECT, NOW, MINUTE, harness, OVERDUE, OPEN_LANE, outstandingWake,
  wakeStateFromRecord, resolveOriginalSend, defaultSeatTickSettings, childFixture, childRig, settleRecordFromJournal, SEND_UNVERIFIED_REASON } from "./seatTickController.fixture";
import { seatTickDeliveryAlarm } from "./seatTickWatchdog";
import { seatTickSettingsAnswer } from "./seatTickSettingsAnswer";

function destination(registry: InstanceType<typeof AgentRegistry>) {
  return (wake: Parameters<typeof wakeStateFromRecord>[0]) => wakeStateFromRecord(wake, {
    lookup: binding => resolveOriginalSend(binding, { registry, client: null }),
    journal: async () => { throw new Error("isolated host unavailable"); },
  });
}

// A real process disappears after admission, before it can record a return.
const crashFile = process.env.LLV_TICK_CRASH_FILE;
test.skipIf(!crashFile)("dispatch crash subprocess", async () => {
  const rig = harness({ stateFile: crashFile, pipelines: OPEN_LANE, now: NOW, deliverWith: async () => { process.exit(0); } });
  await runSeatTickCheck(PROJECT, rig.deps);
  throw new Error("transport crash was not reached");
});

test.skipIf(!!crashFile)("a caller lost across process succession cannot hold subsequent wakes", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const row = rig.deps.readState!(PROJECT), file = row.accounting!.filename.slice(0, -7);
  const child = spawn(process.execPath, ["test", import.meta.path, "--test-name-pattern", "^dispatch crash subprocess$"], {
    env: { ...process.env, LLV_TICK_CRASH_FILE: file }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    expect({ code, output }).toMatchObject({ code: 0 });
  } finally { clearTimeout(watchdog); }
  const lost = rig.deps.readState!(PROJECT).outstandingWake!;
  expect(lost.dispatch?.state).toBe("active"); expect(lost.operationId).toBeNull();
  const next = harness({ pipelines: OPEN_LANE, stateFile: file, now: NOW + 20 * MINUTE });
  next.deps.sources!.wakeState = destination(new AgentRegistry(path.join(SANDBOX, "recovery-registry.json")));
  expect((await runSeatTickCheck(PROJECT, next.deps))?.verdict).toBe("wake");
  expect(next.journal.some(record => record.delivery?.outcome === "dispatch-expired")).toBe(true);
  expect(next.sent).toHaveLength(1);
  expect(next.deps.readState!(PROJECT).outstandingWake).toBeNull();
  await runSeatTickCheck(PROJECT, next.deps);
  expect(next.sent).toHaveLength(1);
  const accounting = new SeatTickAccounting(row.accounting!.filename, PROJECT);
  expect(accounting.dispatchAdmitted(lost.clientMessageId, lost.dispatch!.token)).toBe(false);
});

test("a failed recordless dispatch keeps its transport reason when the current wake replaces it", async () => {
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE, deliveryThrows: true });
  await runSeatTickCheck(PROJECT, first.deps);
  const state = first.deps.readState!(PROJECT);
  expect(state.outstandingWake?.dispatch?.state).toBe("returned");
  const next = harness({ pipelines: OPEN_LANE, stateFile: state.accounting!.filename.slice(0, -7), now: NOW + 20 * MINUTE });
  next.deps.sources!.wakeState = destination(new AgentRegistry(path.join(SANDBOX, "failed-caller-registry.json")));
  await runSeatTickCheck(PROJECT, next.deps);
  expect(next.journal.find(record => record.delivery?.outcome === "dispatch-expired")?.detail).toContain("the delivery layer is unavailable");
  expect(next.sent).toHaveLength(1);
});

test.each(["absent", "landed", "retained", "unreadable"] as const)("legacy active dispatch reconciles destination %s after three checks", async observed => {
  const wake = outstandingWake({ operationId: null, text: "frozen old alarm", preparedAt: new Date(NOW - 20 * MINUTE).toISOString(),
    dispatch: { token: "old-caller", state: "active" } });
  const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: wake } });
  const registry = new AgentRegistry(path.join(fs.mkdtempSync(path.join(SANDBOX, "destination-")), "registry.json"));
  rig.deps.sources!.wakeState = observed === "absent" ? destination(registry)
    : async () => { if (observed === "unreadable") throw new Error("evidence unreadable"); return observed; };
  const result = await runSeatTickCheck(PROJECT, rig.deps);
  if (observed === "absent") {
    expect(rig.sent).toHaveLength(1);
    expect(rig.journal.find(record => record.delivery?.outcome === "dispatch-expired")?.delivery).toMatchObject({ clientMessageId: wake.clientMessageId, outcome: "dispatch-expired" });
    expect(rig.deps.readState!(PROJECT).outstandingWake).toBeNull();
  } else if (observed === "landed") {
    expect(rig.sent).toHaveLength(0); expect(rig.deps.readState!(PROJECT).outstandingWake).toBeNull();
    expect(rig.deps.readState!(PROJECT).lastWakeAt).toBe(new Date(NOW).toISOString());
  } else {
    expect(rig.sent).toHaveLength(0); expect(result?.delivery?.outcome).toBe("deferred-outstanding");
    expect(rig.deps.readState!(PROJECT).outstandingWake?.clientMessageId).toBe(wake.clientMessageId);
  }
});

test("an active caller inside its dispatch deadline cannot be replaced on age alone", async () => {
  const wake = outstandingWake({ operationId: null, text: "frozen alarm", preparedAt: new Date(NOW - 20 * MINUTE).toISOString(),
    dispatch: { token: "live-caller", state: "active", deadlineAt: new Date(NOW + MINUTE).toISOString() } });
  const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: wake } });
  rig.deps.sources!.wakeState = destination(new AgentRegistry(path.join(SANDBOX, "live-caller-registry.json")));
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(0);
  expect(rig.deps.readState!(PROJECT).outstandingWake?.dispatch).toEqual(wake.dispatch);
});

test("the fifteen-minute watchdog persists across checks and names the stuck delivery in board and status", async () => {
  const since = new Date(NOW - 16 * MINUTE).toISOString();
  const wake = outstandingWake({ preparedAt: since, dispatch: { token: "held-caller", state: "returned" } });
  const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: wake } });
  const row = rig.deps.readState!(PROJECT);
  expect(seatTickDeliveryAlarm(row, Date.parse(since) + 15 * MINUTE - 1)).toBeNull();
  expect(seatTickDeliveryAlarm(row, NOW)).toMatchObject({ clientMessageId: wake.clientMessageId, ageMs: 16 * MINUTE });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.cards.some(entry => entry.card.detail.includes("delivery alarm") && entry.card.detail.includes(wake.clientMessageId))).toBe(true);
  const answer = seatTickSettingsAnswer(PROJECT, false, { kind: "gateway", project: null, conversationId: null, seatEpoch: null }, { now: () => NOW, settings: () => defaultSeatTickSettings(PROJECT),
    readState: rig.deps.readState, records: () => rig.journal, policy: () => rig.deps.policy! });
  const { seatTickReading } = await import("@/components/orchestrator/seatTickView");
  const { translate } = await import("@/lib/i18n/core");
  const reading = seatTickReading({ answer, failed: false }, NOW, (key, values) => translate("en", key, values));
  expect(reading.tone).toBe("warn");
  expect(answer.state?.deliveryAlarm?.ageMs).toBe(16 * MINUTE);
  expect(answer.lastRun?.detail).toContain(wake.clientMessageId);
  expect(answer.lastRun?.detail).toContain("ageMs=960000");
  const reopened = new SeatTickAccounting(row.accounting!.filename, PROJECT).readState();
  expect(seatTickDeliveryAlarm(reopened, NOW + MINUTE)?.ageMs).toBe(17 * MINUTE);
  expect(seatTickDeliveryAlarm({ ...reopened, lastWakeAt: new Date(NOW).toISOString() }, NOW)).toBeNull();
});

test("revoking an old token fences a paused caller at real transport reservation", async () => {
  const { childFixture, childRig, hostedSeat, realTransport, setAgentRegistryForTests } = await import("./seatTickController.fixture");
  const Clock = Date;
  globalThis.Date = new Proxy(Clock, { construct(target, args) { return Reflect.construct(target, args.length ? args : [NOW]); },
    get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); } });
  const f = childFixture("dispatch-reservation-race");
  f.seed(OVERDUE);
  const hosted = hostedSeat(f), transport = realTransport(f, hosted.client);
  setAgentRegistryForTests(f.registry);
  await f.registry.prepareRecoveryIndexes();
  let open!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { open = resolve; });
  const release = new Promise<void>(resolve => { resume = resolve; });
  const first = childRig(f, { pipelines: OPEN_LANE.map(lane => ({ ...lane, project: f.project })), realWakeState: true, journal: { client: hosted.client },
    deliverWith: async message => { open(); await release; return transport(message); } });
  const checking = runSeatTickCheck(f.project, first.deps);
  try {
    await entered;
    const old = f.row().outstandingWake!;
    expect(old.dispatch?.state).toBe("active");
    const outcomes: Awaited<ReturnType<typeof transport>>[] = [];
    const next = childRig(f, { pipelines: OPEN_LANE.map(lane => ({ ...lane, project: f.project })), now: f.now + 20 * MINUTE, realWakeState: true, journal: { client: hosted.client },
      deliverWith: async message => { const outcome = await transport(message); outcomes.push(outcome); return outcome; } });
    const observation = await next.deps.sources!.wakeState(old);
    expect(observation).toMatchObject({ state: "absent" });
    await runSeatTickCheck(f.project, next.deps);
    expect(outcomes).toMatchObject([{ ok: true }]);
    expect(next.sent).toHaveLength(1);
    const replacement = next.sent[0]!;
    const heldAfterRecovery = f.row().outstandingWake;
    expect(replacement.clientMessageId).not.toBe(old.clientMessageId);
    expect(outcomes[0]!.operationId).toBeTruthy();
    resume(); await checking;
    expect(await resolveOriginalSend({ conversationId: old.conversationId, clientMessageId: old.clientMessageId, text: old.text },
      { registry: f.registry, client: hosted.client })).toEqual({ kind: "absent" });
    expect(f.row().outstandingWake).toEqual(heldAfterRecovery);
  } finally { resume(); await checking; hosted.journal.close(); }
});

test.each(["queued", "landed"] as const)("a late %s return cannot change a replacement dispatch under the same key", async kind => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, deliverWith: async () => {
    entered(); await held;
    return { ok: true, outcome: kind === "landed" ? "delivered" : "queued", operationId: "old-operation", target: null };
  } });
  const checking = runSeatTickCheck(PROJECT, rig.deps);
  try {
    await ready;
    const state = rig.deps.readState!(PROJECT), store = new SeatTickAccounting(state.accounting!.filename, PROJECT);
    const wake = state.outstandingWake!;
    expect(store.fenceExpiredDispatch(wake, new Date(NOW + 20 * MINUTE).toISOString(), 0)).toBe(true);
    expect(store.confirmFencedAbsent(store.readState().outstandingWake!)).toBe(true);
    const replacement = store.beginDispatch(store.readState().outstandingWake!, new Date(NOW + 30 * MINUTE).toISOString());
    const current = store.readState().outstandingWake;
    release(); await checking;
    expect(replacement).toBeTruthy();
    expect(store.readState().outstandingWake).toEqual(current);
    expect(store.readState().lastWakeAt).toBe(OVERDUE.lastWakeAt);
  } finally { release(); await checking; }
});

test("a caller paused before transport cannot borrow a newer token for the same key", async () => {
  const { childFixture, childRig, hostedSeat, realTransport, setAgentRegistryForTests } = await import("./seatTickController.fixture");
  const f = childFixture("dispatch-token-swap");
  f.seed(OVERDUE);
  const hosted = hostedSeat(f);
  setAgentRegistryForTests(f.registry);
  await f.registry.prepareRecoveryIndexes();
  const store = new SeatTickAccounting(`${f.stateFile}.sqlite`, f.project);
  let replacement: string | null = null, original: ReturnType<typeof outstandingWake> | null = null;
  const rig = childRig(f, { pipelines: OPEN_LANE.map(lane => ({ ...lane, project: f.project })),
    realWakeState: true, journal: { client: hosted.client }, deliverWith: realTransport(f, hosted.client) });
  rig.deps.mcpHealth = () => {
    const wake = f.row().outstandingWake;
    if (!replacement && wake?.dispatch?.state === "active") {
      original = wake;
      expect(store.fenceExpiredDispatch(wake, new Date(f.now + 20 * MINUTE).toISOString(), 0)).toBe(true);
      expect(store.confirmFencedAbsent(store.readState().outstandingWake!)).toBe(true);
      replacement = store.beginDispatch(store.readState().outstandingWake!, new Date(f.now + 30 * MINUTE).toISOString());
    }
    return { status: "untracked", detail: "isolated token-swap probe" };
  };
  try {
    await runSeatTickCheck(f.project, rig.deps);
    expect(replacement).toBeTruthy();
    expect(f.row().outstandingWake?.dispatch).toMatchObject({ token: replacement, state: "active" });
    expect(f.row().outstandingWake?.operationId).toBeNull();
    const wake = original as ReturnType<typeof outstandingWake> | null;
    if (!wake) throw new Error("token swap did not observe the original attempt");
    expect(await resolveOriginalSend({ conversationId: wake.conversationId, clientMessageId: wake.clientMessageId, text: wake.text },
      { registry: f.registry, client: hosted.client })).toEqual({ kind: "absent" });
  } finally { hosted.journal.close(); }
});

test.each(["landed", "codex-landed", "absent", "unreadable", "oversized"] as const)("a missing reservation is resolved from destination history (%s)", async state => {
  const { destinationWakeState } = await import("./seatTickSources");
  const directory = fs.mkdtempSync(path.join(SANDBOX, "destination-history-"));
  const transcript = path.join(directory, "native.jsonl");
  const text = "A frozen wake with its original event identities";
  fs.writeFileSync(transcript, JSON.stringify(state === "codex-landed"
    ? { type: "event_msg", payload: { type: "user_message", message: text } }
    : { type: "user", message: { role: "user", content: state === "landed" ? text : "An unrelated ordinary input" } }) + "\n");
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const conversation = registry.ensureConversation(state === "codex-landed" ? "codex" : "claude", transcript, null);
  const wake = outstandingWake({ conversationId: conversation.id, operationId: null, text });
  if (state === "unreadable") fs.unlinkSync(transcript);
  if (state === "oversized") fs.truncateSync(transcript, 65 * 1024 * 1024);
  const observation = await wakeStateFromRecord(wake, {
    lookup: binding => resolveOriginalSend(binding, { registry, client: null }),
    destination: candidate => destinationWakeState(candidate, registry),
    journal: async () => { throw new Error("no isolated runtime"); },
  });
  expect(observation.state).toBe((state === "landed" || state === "codex-landed") ? "landed" : state === "absent" ? "absent" : "unknown");
  if (state === "landed" || state === "codex-landed") expect(observation.evidence!.confirmation).toBe("destination-transcript");
});


test.each(["in-flight", "unverified"] as const)("reconciliation preserves arrival during an awaited journal read (%s)", async initial => {
  const Clock = Date;
  globalThis.Date = new Proxy(Clock, { construct(target, args) { return Reflect.construct(target, args.length ? args : [NOW]); },
    get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); } });
  const f = childFixture(`journal-arrival-${initial}`);
  f.seed(OVERDUE);
  const pipelines = [{ ...OPEN_LANE[0]!, id: "arrival-lane", project: f.project, state: "completed", src: f.seat.conversationId }];
  const first = childRig(f, { pipelines, delivery: { ok: true, target: null, outcome: "queued", operationId: "arrival-operation" } });
  first.deps.sources!.reports = { log: () => [], enabled: () => true, operatorLocale: () => "uk" };
  expect(await runSeatTickCheck(f.project, first.deps)).toMatchObject({ verdict: "wake", delivery: { outcome: "queued" } });
  const wake = f.row().outstandingWake!;
  expect(wake.commit.announcedLanes).toHaveLength(1);
  expect(wake.commit.reportsOwed).toHaveLength(1);
  const held = f.registry.holdDelivery(f.seat.conversationId as never, wake.text!, wake.clientMessageId, "text", [], null,
    { operationId: wake.operationId!, kind: "send", policy: "queue" });
  if (initial === "unverified") f.registry.recordDeliveryOutcome(held.id, "failed", "arrival unknown", "unverified");
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const next = childRig(f, { pipelines });
  let observation: Awaited<ReturnType<typeof wakeStateFromRecord>> | undefined;
  next.deps.sources!.wakeState = async pending => {
    let evidence: Awaited<ReturnType<typeof resolveOriginalSend>>;
    observation = await wakeStateFromRecord(pending, {
      lookup: async binding => (evidence = await resolveOriginalSend(binding, { registry: f.registry, client: null })),
      settle: async () => evidence.kind === "found" && evidence.current.readable ? evidence.current.value : null,
      journal: async () => { entered(); await waiting; return { status: "rejected", reason: "earlier journal rejection" }; },
      settleFromJournal: (target, receipt) => settleRecordFromJournal(f.registry, target, receipt),
    });
    return observation;
  };
  const checking = runSeatTickCheck(f.project, next.deps);
  try {
    await ready;
    f.registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
    release();
    await checking;
    expect(observation).toMatchObject({ state: "landed", evidence: { record: { state: "delivered" } } });
    expect(next.sent).toHaveLength(0);
    const landing = next.journal.find(record => record.verdict === "landed" && record.delivery?.clientMessageId === wake.clientMessageId);
    expect(landing).toBeDefined();
    expect(landing!.detail).not.toContain("settled delivered on the journal's own verdict");
    expect(f.row()).toMatchObject({ outstandingWake: null, announcedLanes: wake.commit.announcedLanes });
    expect(f.row().reportsOwed?.map(entry => entry.key)).toEqual(wake.commit.reportsOwed!.map(entry => entry.key));
  } finally { release(); await checking; }
});


test.each([[2, "uncertain"], [20, "uncertain"], [180, "uncertain"], [20, "interrupted"], [20, "failed"]] as const)(
  "a returned terminal-unverified operation releases its obligations at age %s minutes (%s)", async (age, status) => {
  const f = childFixture(`terminal-${status}-${age}`);
  const diagnostic = status === "failed" ? SEND_UNVERIFIED_REASON : "terminal arrival uncertainty";
  const privatePath = ["", "home", "fixture", "nested", "problem.txt"].join("/");
  const reason = age === 2 ? `${diagnostic}; path ${privatePath}` : diagnostic;
  const prepared = NOW - age * MINUTE;
  const wake = outstandingWake({ conversationId: f.seat.conversationId!, seatEpoch: f.seat.seatEpoch,
    text: "original wake with uncredited work", preparedAt: new Date(prepared).toISOString(),
    dispatch: { token: "ended", state: "returned", uncertain: true,
      deadlineAt: new Date(prepared + 75_000).toISOString(), reason: "arrival could not be verified" } });
  f.seed({ ...OVERDUE, eventsThrough: 2, outstandingWake: wake });
  const held = f.registry.holdDelivery(wake.conversationId as never, wake.text!, wake.clientMessageId, "text", [], null,
    { operationId: wake.operationId!, kind: "send", policy: "queue" });
  f.registry.recordDeliveryOutcome(held.id, "failed", "arrival could not be verified", "unverified");
  const rig = childRig(f, { pipelines: [{ id: "unreported-outcome", project: f.project, state: "completed", src: wake.conversationId,
    createdAt: new Date(prepared - MINUTE).toISOString(), movedAt: new Date(prepared).toISOString() }], now: NOW });
  rig.deps.sources!.settings = () => ({ ...defaultSeatTickSettings(f.project), wakeIntervalMinutes: 10 });
  rig.deps.sources!.wakeState = pending => wakeStateFromRecord(pending, {
    lookup: binding => resolveOriginalSend(binding, { registry: f.registry, client: null }),
    journal: async () => ({ status, reason }),
  });
  const before = f.row();
  expect(before.announcedLanes).not.toContain("unreported-outcome:completed");
  await runSeatTickCheck(f.project, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.clientMessageId).not.toBe(wake.clientMessageId);
  expect(rig.sent[0]!.text).toContain("unreported-outcome");
  const released = rig.journal.find(record => record.delivery?.clientMessageId === wake.clientMessageId);
  expect(released?.detail).toContain(diagnostic);
  if (age === 2) {
    expect(released?.detail).not.toContain(privatePath);
    expect(released?.detail).toContain("problem.txt");
  }
  expect(released?.verdict).toBe("dropped");
  expect(f.row().eventsThrough).toBe(before.eventsThrough);
  expect(f.row().announcedLanes).toContain("unreported-outcome:completed");
  expect(f.row().outstandingWake).toBeNull();
  await runSeatTickCheck(f.project, rig.deps);
  expect(rig.sent).toHaveLength(1);
});

test.each(["pending", "delivering", "unreachable", "no-record", "before-deadline", "active-caller", "caller-changed", "foreign-operation"] as const)(
  "%s evidence keeps the admission fence for an uncertain dispatch", async mode => {
    const wake = outstandingWake({ preparedAt: new Date(NOW - (mode === "active-caller" ? 2 : 20) * MINUTE).toISOString(),
      dispatch: { token: "pending", state: mode === "active-caller" ? "active" : "returned", uncertain: true,
        deadlineAt: new Date(mode === "before-deadline" ? NOW + MINUTE : NOW - MINUTE).toISOString() } });
    const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: wake } });
    const registry = new AgentRegistry(path.join(fs.mkdtempSync(path.join(SANDBOX, "live-operation-")), "registry.json"));
    const held = registry.holdDelivery(wake.conversationId as never, "wake", wake.clientMessageId, "text", [], null,
      { operationId: mode === "foreign-operation" ? "another-operation" : wake.operationId!, kind: "send", policy: "queue" });
    registry.recordDeliveryOutcome(held.id, "failed", "arrival unverified", "unverified");
    rig.deps.sources!.wakeState = pending => wakeStateFromRecord(pending, {
      lookup: binding => resolveOriginalSend(binding, { registry, client: null }),
      journal: async () => {
        if (mode === "unreachable") throw new Error("isolated journal unavailable");
        if (mode === "no-record") return null;
        if (mode === "caller-changed") {
          const state = rig.deps.readState!(PROJECT);
          const store = new SeatTickAccounting(state.accounting!.filename, PROJECT);
          store.writeState({ ...state, outstandingWake: { ...state.outstandingWake!,
            dispatch: { token: "new-caller", state: "active", deadlineAt: new Date(NOW + MINUTE).toISOString() } } });
        }
        return { status: mode === "pending" || mode === "delivering" ? mode : "uncertain", reason: "arrival unverified" };
      },
    });
    await runSeatTickCheck(PROJECT, rig.deps);
    expect(rig.sent).toHaveLength(0);
    expect(rig.deps.readState!(PROJECT).outstandingWake?.clientMessageId).toBe(wake.clientMessageId);
    expect(rig.journal.some(record => record.delivery?.clientMessageId === wake.clientMessageId && record.verdict === "dropped")).toBe(false);
    if (mode === "caller-changed") expect(rig.deps.readState!(PROJECT).outstandingWake?.dispatch?.token).toBe("new-caller");
  });
