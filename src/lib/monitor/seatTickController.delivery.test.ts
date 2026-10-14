import { expect, test, fs, path, spawn, SANDBOX, runSeatTickCheck, SEAT_TICK_WAKE_UNRESOLVED_REF, writeDrain, drainFile, releaseDrain, DEFAULT_SEAT_TICK_POLICY, defaultSeatTickSettings, FileClaudeDeliveryLedger, resolveOriginalSend, SEND_UNVERIFIED_REASON, SEND_DISCARDED_REASON, DELIVERY_FENCED_BY_SETTLEMENT, StructuredDeliveryQueue, createFakeDeliveryLedger, FakeEngineHost, structuredContentDigest, RUNTIME_IDEMPOTENCY_KEY_LIMIT, RuntimeJournal, writeSeatTickState, appendSeatTickRecord, readSeatTickRecords, SeatTickAccounting, FileRuntimeEventStore, statePath, setAgentRegistryForTests, emptyLaunchProfile, PROJECT, CONVERSATION, SUCCESSOR, NOW, MINUTE, harness, fakeJournal, OVERDUE, RECENT, outstandingWake, OPEN_LANE, childFixture, childRig, ago, refuseBeforeReservation, successorSeat, strandOneWake, retiredEntry, SEAT_TICK_COMMAND, reservedThenTimedOut, admittedAndRejected, strandedManagerWake, frozen, hostedSeat, realTransport, MUTE_PROMPT, admissionCommand, ownLane, ageTranscript, sweepRegistryRow } from "./seatTickController.fixture";
import type { HostState, SeatTickOutstandingWake, SeatTickRunRecord, AgentLivenessRecord, ConversationMessage, DeliveryOutcome, ChildFixture } from "./seatTickController.fixture";


/* Running children are observed through a rotating window, so a stall on a
   child beyond the eighth is seen on two consecutive checks and reported —
   the fixed identity-ordered eight this replaces never observed it. */
test("a stall on the twelfth of twelve running children is reported within two sweeps of it entering the window (#1465)", async () => {
  const fixture = childFixture("twelve-running");
  const children = Array.from({ length: 12 }, (_, index) => fixture.spawn({ title: `worker ${index + 1}`, turn: "busy", host: "live" }));
  // Discovery starts the running queue in insertion order.
  const ids = children.map((child) => child.id);
  const twelfth = children.find((child) => child.id === ids[11])!;
  fixture.seed();
  const activity: Record<string, Partial<AgentLivenessRecord>> = Object.fromEntries(children.map((child) => [child.id, { lifecycle: "running", reason: "host_alive_turn_active" }]));
  activity[twelfth.id] = { lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "busy" };

  const first = childRig(fixture, { childActivity: activity });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(first.liveness.map((read) => read.conversationId)).toEqual(ids.slice(0, 8));
  expect(fixture.row().stalledSeen).toEqual([]);

  const second = childRig(fixture, { childActivity: activity, now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, second.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(second.liveness.map((read) => read.conversationId)).toEqual(ids.slice(4, 12));
  expect(fixture.row().stalledSeen).toEqual([`child:${twelfth.id}`]);

  const third = childRig(fixture, { childActivity: activity, now: fixture.now + 122 * MINUTE });
  const stalled = await runSeatTickCheck(fixture.project, third.deps);
  expect(third.liveness.map((read) => read.conversationId)).toEqual([...ids.slice(8, 12), ...ids.slice(0, 4)]);
  expect(stalled).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  expect(stalled!.detail).toContain(`child ${twelfth.id} runs a turn the registry reports stalled (host_alive_transcript_silent)`);
  expect(third.sent[0]!.text).toContain(`[child] ${twelfth.id}`);
  /* Every check observed a bounded window and asked liveness for it alone. */
  for (const rig of [first, second, third]) expect(rig.liveness).toHaveLength(8);
});

/* A registry without an indexed lineage projection reads the seat and names
   the children as unindexed; the check does not fail (#1465). */
test("a JSON-mode registry leaves the seat readable and reports the children as unindexed (#1465)", async () => {
  const fixture = childFixture("json-registry", false, "off");
  fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const rig = childRig(fixture, { tasks: [{ id: "task_j1", status: "assigned" }] });
  const sources = { ...rig.deps.sources!, tasks: () => [{ id: "task_j1", project: fixture.project, status: "assigned", text: "card", placement: "unplaced", assignments: [], createdAt: ago(fixture, 30), updatedAt: ago(fixture, 30) }] as never };
  const record = await runSeatTickCheck(fixture.project, { ...rig.deps, sources });
  expect(record).toMatchObject({ verdict: "wake", reasons: ["unstarted-task"] });
  expect(record!.detail).toContain("(children-unindexed): the registry backend has no indexed lineage projection");
  expect(rig.sent[0]!.text).toContain("children-unindexed");
  expect(fixture.row().childrenGap).toMatchObject({ gap: "children-unindexed" });
});

/* A legacy tick state that cannot be imported blocks every prepare. That must
   never be silent (#1465): the refusal is named in the journal, the condition
   is a run of its own, and it reaches the board once it has outlived the wake
   interval — with the clause that says which file to look at. */
test("a blocked legacy import names itself in the journal and reaches the board after one wake interval (#1465)", async () => {
  const fixture = childFixture("blocked-migration");
  fixture.spawn({ title: "worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fs.writeFileSync(fixture.stateFile, "{ this is not the tick state");
  fixture.seed();
  expect(fixture.row().accounting?.gap).toBe("legacy-json-malformed");
  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, first.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "accounting-blocked" } });
  expect(record!.detail).toContain("(migration-blocked): the legacy tick state at state/seat-tick.json cannot be imported");
  expect(first.sent).toEqual([]);
  expect(fixture.acknowledged()).toEqual([]);
  expect(fixture.row().childrenGap).toMatchObject({ gap: "migration-blocked", attempts: 1 });
  const standing = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, standing.deps);
  expect(standing.cards.map((entry) => entry.card)).toMatchObject([{ ref: "seat-tick-source-children", kind: "source-unreadable" }]);
  expect(standing.cards[0]!.card.detail).toContain("migration-blocked, 2 attempt(s)");
  expect(standing.cards[0]!.card.detail).toContain("state/seat-tick.json");
  /* Fixing the file unblocks the import, and the next check wakes. */
  fs.unlinkSync(fixture.stateFile);
  const fixed = childRig(fixture, { now: fixture.now + 66 * MINUTE });
  expect(fixture.row().accounting?.gap).toBeNull();
  const woken = await runSeatTickCheck(fixture.project, fixed.deps);
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(fixed.sent).toHaveLength(1);
});

test("a returned 409 or 503 refusal is fenced across rotation and the successor acknowledges once (#1465)", async () => {
  for (const status of [409, 503] as const) {
    const fixture = childFixture(`rotated-refusal-${status}`);
    setAgentRegistryForTests(fixture.registry);
    const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
    fixture.seed();
    const first = childRig(fixture, { realWakeState: true, deliverWith: refuseBeforeReservation(status) });
    await runSeatTickCheck(fixture.project, first.deps);
    const original = fixture.row().outstandingWake!;
    expect(original.operationId).toBeNull();
    expect(await resolveOriginalSend({ conversationId: original.conversationId, clientMessageId: original.clientMessageId }, { registry: fixture.registry, client: null })).toEqual({ kind: "absent" });
    const successor = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
    const seat = { conversationId: successor.id, seatEpoch: 8, path: successor.generations[0]!.path };
    const next = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 5 * MINUTE, deliverWith: async (message) => {
      expect(fixture.acknowledged()).toEqual([]);
      expect(fixture.row().lastWakeAt).toBe(ago(fixture, 61));
      const held = fixture.registry.holdDelivery(successor.id, message.text, message.clientMessageId);
      fixture.registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
      return { ok: true, target: "structured", outcome: "delivered", structured: true };
    } });
    await runSeatTickCheck(fixture.project, next.deps);
    expect(next.journal[0]).toMatchObject({ verdict: "revoked", delivery: { clientMessageId: original.clientMessageId, outcome: "unsent" } });
    expect(next.sent).toHaveLength(1);
    expect(next.sent[0]!.clientMessageId).not.toBe(original.clientMessageId);
    expect(next.sent[0]!.conversationId).toBe(successor.id);
    expect(next.sent[0]!.text).toContain(child.id);
    expect(fixture.acknowledged()).toEqual([child.id]);
    const again = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 10 * MINUTE });
    await runSeatTickCheck(fixture.project, again.deps);
    expect(again.sent).toEqual([]);
    expect(fixture.acknowledged()).toEqual([child.id]);
  }
});

test("dead Viewer MCP withholds a recordless refusal retry under its original key until recovery", async () => {
  const fixture = childFixture("mcp-refused-retry");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture, {
    realWakeState: true, deliverWith: refuseBeforeReservation(503),
  }).deps);
  const pending = fixture.row().outstandingWake!;
  expect(pending).toMatchObject({ operationId: null, dispatch: { state: "refused" } });

  const unavailable = childRig(fixture, { realWakeState: true, now: fixture.now + 5 * MINUTE });
  const dead = await runSeatTickCheck(fixture.project, { ...unavailable.deps,
    mcpHealth: () => ({ status: "dead", detail: "stdio MCP has no heartbeat" }),
  });
  expect(unavailable.sent).toEqual([]);
  expect(dead?.delivery?.outcome).toBe("seat-mcp-unavailable");
  expect(unavailable.cards.some(({ card }) => card.kind === "mcp-unavailable" && card.state === "open")).toBe(true);
  expect(fixture.row().outstandingWake).toEqual(pending);
  expect(fixture.acknowledged()).toEqual([]);

  const recovered = childRig(fixture, { realWakeState: true, now: fixture.now + 10 * MINUTE });
  await runSeatTickCheck(fixture.project, { ...recovered.deps,
    mcpHealth: () => ({ status: "healthy", detail: "stdio MCP is live" }),
  });
  expect(recovered.sent).toHaveLength(1);
  expect(recovered.sent[0]).toMatchObject({ clientMessageId: pending.clientMessageId, text: pending.text });
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(fixture.row().outstandingWake).toBeNull();
});

test("a dead-host original-key retry recovers without changing its wake or acknowledging early", async () => {
  const fixture = childFixture("dead-host-same-key");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture, { realWakeState: true, deliverWith: refuseBeforeReservation(503) }).deps);
  const pending = fixture.row().outstandingWake!;
  const recovered = childRig(fixture, { realWakeState: true, now: fixture.now + 5 * MINUTE,
    seatActivity: { conversationId: fixture.seat.conversationId, host: { state: "gone", kind: "structured", pid: null }, reason: "host_gone_turn_settled", lifecycle: "gone" },
    deliverWith: async message => {
      expect(fixture.acknowledged()).toEqual([]);
      expect(message.clientMessageId).toBe(pending.clientMessageId);
      return { ok: true, target: null, outcome: "delivered", structured: true, spawned: true };
    },
  });
  recovered.deps.mcpHealth = () => ({ status: "dead", detail: "old MCP absent" });
  await runSeatTickCheck(fixture.project, recovered.deps);
  expect(recovered.sent).toHaveLength(1);
  expect(recovered.sent[0]!.text).toBe(pending.text!);
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(fixture.row().outstandingWake).toBeNull();
  expect(fixture.row().hostRecovery?.state).toBe("revived");
});

test.each(["retained", "uncertain", "unknown", "unreadable"] as const)("a failed revival with a %s operation never rotates or loses its key", async wakeState => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE,
    wakeState: wakeState === "unreadable" ? "unknown" : wakeState, holderThrows: wakeState === "unreadable",
    seatActivity: { conversationId: CONVERSATION, host: { state: "gone", kind: "structured", pid: null }, reason: "host_gone_turn_settled", lifecycle: "gone" },
    delivery: { ok: false, outcome: "failed", status: 503, error: "resume failed", code: "structured_revival_impossible", operationId: "original-operation" },
  });
  let rotations = 0;
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "old MCP absent" });
  rig.deps.seatRecovery = { rotate: async () => { rotations += 1; return { status: 200, body: { ok: true } }; } };
  await runSeatTickCheck(PROJECT, rig.deps);
  const pending = rig.deps.readState!(PROJECT).outstandingWake!;
  expect(pending.operationId).toBe("original-operation");
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rotations).toBe(0);
  expect(rig.sent).toHaveLength(1);
  expect(rig.deps.readState!(PROJECT).outstandingWake?.clientMessageId).toBe(pending.clientMessageId);
});

test("a drain retains an unaccepted wake's original key until its retry is admitted", async () => {
  const fixture = childFixture("drain-refused-retry");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture, { realWakeState: true, deliverWith: refuseBeforeReservation(503) }).deps);
  const pending = fixture.row().outstandingWake!;
  writeDrain(drainFile(), { id: "retry-seat", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
  try {
    const held = childRig(fixture, { realWakeState: true, now: fixture.now + 5 * MINUTE });
    await runSeatTickCheck(fixture.project, held.deps);
    expect(held.sent).toEqual([]);
    expect(fixture.row().outstandingWake).toEqual(pending);
    expect(fixture.acknowledged()).toEqual([]);
    releaseDrain(drainFile(), "retry-seat");
    const resumed = childRig(fixture, { realWakeState: true, now: fixture.now + 10 * MINUTE });
    await runSeatTickCheck(fixture.project, resumed.deps);
    expect(resumed.sent).toHaveLength(1);
    expect(resumed.sent[0]).toMatchObject({ clientMessageId: pending.clientMessageId, text: pending.text });
    expect(fixture.acknowledged()).toEqual([child.id]);
    expect(fixture.row().outstandingWake).toBeNull();
  } finally { releaseDrain(drainFile(), "retry-seat"); }
});

test("a paused old lookup cannot dispatch after a successor replaces the refused wake (#1465)", async () => {
  const fixture = childFixture("old-lookup-interleaving");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture, { realWakeState: true, deliverWith: refuseBeforeReservation(503) }).deps);
  const original = fixture.row().outstandingWake!;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const old = childRig(fixture, { realWakeState: true, now: fixture.now + 5 * MINUTE });
  const lookup = old.deps.sources!.wakeState!;
  let paused = false;
  const pending = runSeatTickCheck(fixture.project, { ...old.deps, sources: { ...old.deps.sources!, wakeState: async (wake) => {
    const evidence = await lookup(wake);
    if (!paused) { paused = true; entered(); await blocked; }
    return evidence;
  } } });
  await waiting;
  const successor = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  const next = childRig(fixture, { realWakeState: true, seat: { conversationId: successor.id, seatEpoch: 8, path: null }, now: fixture.now + 6 * MINUTE });
  await runSeatTickCheck(fixture.project, next.deps);
  expect(next.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
  release();
  await pending;
  expect(old.sent).toEqual([]);
  expect(await resolveOriginalSend({ conversationId: original.conversationId, clientMessageId: original.clientMessageId }, { registry: fixture.registry, client: null })).toEqual({ kind: "absent" });
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a dispatch paused before reservation blocks rotation until its returned refusal is fenced (#1465)", async () => {
  const fixture = childFixture("active-dispatch-interleaving");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  fixture.seed();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = childRig(fixture, { realWakeState: true, deliverWith: async (message) => {
    entered(); await blocked;
    return refuseBeforeReservation(503)(message);
  } });
  const pending = runSeatTickCheck(fixture.project, first.deps);
  await waiting;
  const original = fixture.row().outstandingWake!;
  expect(original.dispatch?.state).toBe("active");
  const seat = { ...fixture.seat, seatEpoch: 8 };
  const rotated = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, rotated.deps);
  expect(rotated.sent).toEqual([]);
  expect(fixture.row().outstandingWake).toEqual(original);
  expect(rotated.cards.map(({ card }) => card.ref)).toContain(SEAT_TICK_WAKE_UNRESOLVED_REF);
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  expect(accounting.settleAbsent(original)).toBe(false);
  expect(accounting.cancelUndispatched(original)).toBe(false);
  release(); await pending;
  const returned = fixture.row().outstandingWake!;
  expect(returned.dispatch?.state).toBe("refused");
  const next = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 62 * MINUTE });
  await runSeatTickCheck(fixture.project, next.deps);
  expect(next.sent).toHaveLength(1);
  expect(accounting.beginDispatch(returned)).toBeNull();
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("rotation retains absent legacy, unknown, unreadable, uncertain and too-late attempts with attention (#1465)", async () => {
  for (const mode of ["legacy", "unknown", "unreadable", "uncertain", "too-late", "started"] as const) {
    const fixture = childFixture(`rotated-mirror-${mode}`);
    setAgentRegistryForTests(fixture.registry);
    fixture.spawn({ title: "owed worker", turn: "terminal" });
    fixture.seed();
    await runSeatTickCheck(fixture.project, childRig(fixture, { realWakeState: true,
      ...(mode === "started" ? { delivery: { ok: false, outcome: "failed", error: "arrival unknown", status: 409, actuation: "started", resend: "verify-first" } as DeliveryOutcome }
        : { deliverWith: refuseBeforeReservation(409) }),
    }).deps);
    if (mode === "legacy" || mode === "unknown") {
      const state = fixture.row();
      writeSeatTickState(fixture.project, { ...state, outstandingWake: { ...state.outstandingWake!, dispatch: undefined,
        operationId: mode === "unknown" ? "unreadable-operation" : null } }, fixture.stateFile);
    }
    if (mode === "uncertain") {
      const wake = fixture.row().outstandingWake!;
      const held = fixture.registry.holdDelivery(wake.conversationId as never, wake.text!, wake.clientMessageId, "text", [], null, { operationId: "unverified-operation", kind: "send", policy: "queue" });
      fixture.registry.recordDeliveryOutcome(held.id, "failed", "arrival unverified", "unverified");
    }
    const original = fixture.row().outstandingWake!;
    const rig = childRig(fixture, { realWakeState: mode !== "too-late", wakeState: "retained", withdrawal: "too-late",
      seat: { ...fixture.seat, seatEpoch: 8 }, now: fixture.now + 61 * MINUTE });
    if (mode === "unreadable") rig.deps.sources!.wakeState = async () => { throw new Error("unreadable registry"); };
    await runSeatTickCheck(fixture.project, rig.deps);
    expect(rig.sent).toEqual([]);
    expect(fixture.row().outstandingWake).toEqual(original);
    expect(fixture.acknowledged()).toEqual([]);
    expect(rig.cards.map(({ card }) => card.ref)).toContain(SEAT_TICK_WAKE_UNRESOLVED_REF);
  }
});

test("435 cold acknowledged children do not delay a new worker or its completion, and cold turns remain observable (#1465)", async () => {
  let payloadRows = 0;
  const fixture = childFixture("large-cold-fleet", false, "sqlite", (_collection, count) => { payloadRows += count; });
  const cold = Array.from({ length: 435 }, (_, index) => fixture.spawn({ title: `cold worker ${index}`, turn: "terminal" }));
  fixture.seed();
  const settings = { ...defaultSeatTickSettings(fixture.project), wakeIntervalMinutes: 5 };
  const policy = { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 20 };
  let clock = fixture.now;
  let projectedRows = 0;
  let projectionBytes = 0;
  let fetchedBytes = 0;
  let maxRows = 0;
  let maxPayloadRows = 0;
  let maxBytes = 0;
  const pageChildren = fixture.registry.pageSeatChildren.bind(fixture.registry);
  fixture.registry.pageSeatChildren = (...args) => {
    const page = pageChildren(...args);
    projectedRows += page?.keys.length ?? 0;
    projectionBytes += Buffer.byteLength(JSON.stringify(page?.file ?? {}));
    return page;
  };
  const check = async (over: Parameters<typeof harness>[0] = {}) => {
    projectedRows = 0; payloadRows = 0; projectionBytes = 0; fetchedBytes = 0;
    const read = fs.readSync;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      const bytes = Reflect.apply(read, fs, args) as number;
      fetchedBytes += bytes;
      return bytes;
    }) as typeof fs.readSync;
    const rig = childRig(fixture, { now: clock, settings, ...over });
    let result;
    try { result = await runSeatTickCheck(fixture.project, { ...rig.deps, policy }); }
    finally { fs.readSync = read; }
    expect(projectedRows).toBeLessThanOrEqual(60);
    expect(payloadRows).toBeLessThanOrEqual(600);
    expect(projectionBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(fetchedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(rig.snapshots).toBe(0);
    expect(result?.detail).not.toContain("ledger-pending");
    maxRows = Math.max(maxRows, projectedRows);
    maxPayloadRows = Math.max(maxPayloadRows, payloadRows);
    maxBytes = Math.max(maxBytes, fetchedBytes);
    clock += 5 * MINUTE;
    return { result, rig };
  };
  // Establish real acknowledged history through the controller and event ledgers.
  const named: string[] = [];
  for (let tick = 0; tick < 100 && fixture.acknowledged().length < cold.length; tick++) {
    const { rig } = await check();
    for (const message of rig.sent) for (const match of message.text.matchAll(/^- \[child\] (\S+) .*outcome announcement owed$/gm)) named.push(match[1]!);
  }
  expect(named.length).toBe(435);
  expect(new Set(named)).toEqual(new Set(cold.map((child) => child.id)));
  // Move the old key-ordered implementation to the beginning of a cold sweep.
  // This uses observation only and makes the regression deterministic on that head.
  for (let tick = 0; tick < 22; tick++) await check();
  const fresh = fixture.spawn({ title: "new worker", turn: "busy", host: "live" });
  const generation = fixture.registry.conversation(fresh.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "fresh-turn", seq: 1 });
  const discovered = await check({ childActivity: { [fresh.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });
  expect(discovered.result).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(discovered.rig.sent[0]!.text).toContain(fresh.id);
  ledger.append(generation, { kind: "turn-ended", turnId: "fresh-turn", status: "completed", seq: 2 });
  fixture.registry.reconcileConversations([{
    engine: "claude", path: fresh.path, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "new worker" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: new Date(clock).toISOString() }, observedAt: new Date(clock).toISOString(),
  }]);
  const finished = await check();
  expect(finished.result).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(finished.rig.sent[0]!.text).toContain(fresh.id);
  expect(fixture.acknowledged().filter((id) => id === fresh.id)).toHaveLength(1);
  // A cold child's later turn is owed even without a sampled running state.
  const oldest = cold[0]!;
  const oldGeneration = fixture.registry.conversation(oldest.id as never)!.generations[0]!.id;
  ledger.append(oldGeneration, { kind: "turn-started", turnId: "cold-again", seq: 3 });
  ledger.append(oldGeneration, { kind: "turn-ended", turnId: "cold-again", status: "completed", seq: 4 });
  for (let tick = 0; tick < 55 && fixture.acknowledged().filter((id) => id === oldest.id).length < 2; tick++) await check();
  expect(fixture.acknowledged()).toHaveLength(437);
  expect(fixture.acknowledged().filter((id) => id === oldest.id)).toHaveLength(2);
  for (let tick = 0; tick < 3; tick++) expect((await check()).rig.sent).toEqual([]);
  console.log(`[435 cold] max projected rows ${maxRows}, payload rows ${maxPayloadRows}, positional bytes ${maxBytes}; new running check 1, completion check 1, 437 acknowledged outcomes`);
}, 300_000);

test("new-child discovery runs during historical bootstrap and keeps every older obligation (#1465)", async () => {
  const fixture = childFixture("bootstrap-tail");
  const historical = Array.from({ length: 63 }, (_, n) => fixture.spawn({ title: `historical ${n}`, turn: "terminal" }));
  fixture.seed();
  const policy = { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 20 };
  await runSeatTickCheck(fixture.project, { ...childRig(fixture).deps, policy });
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  const owner = accounting.page("owner", 1)[0]!;
  expect(owner.kind === "owner" && owner.bootstrap).toBeTruthy();
  const fresh = fixture.spawn({ title: "new during bootstrap", turn: "busy", host: "live" });
  const generation = fixture.registry.conversation(fresh.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "new-during-bootstrap", seq: 1 });
  const next = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, { ...next.deps, policy });
  expect(next.liveness.map((read) => read.conversationId)).toContain(fresh.id);
  for (let tick = 2; tick < 8; tick++) {
    const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE });
    await runSeatTickCheck(fixture.project, { ...rig.deps, policy });
  }
  expect(new Set(fixture.acknowledged())).toEqual(new Set(historical.map((child) => child.id)));
  expect(fixture.acknowledged()).toHaveLength(63);
  expect(accounting.page("child", 100)).toHaveLength(64);
  const completedOwner = accounting.page("owner", 1)[0]!;
  expect(completedOwner.kind === "owner" && completedOwner.bootstrap).toBeUndefined();
}, 30_000);

test("a wake stranded by a replaced seat is retired, and the successor's own wake goes out (#1594)", async () => {
  const fixture = childFixture("stranded-retired-seat");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  const stranded = await strandOneWake(fixture, 140);
  expect(stranded).toMatchObject({ seatEpoch: 140, operationId: null, dispatch: { state: "refused" } });
  expect(fixture.acknowledged()).toEqual([]);

  const successor = successorSeat(fixture, 155);
  const rig = childRig(fixture, { realWakeState: true, seat: successor, now: fixture.now + 34 * 60 * MINUTE });
  const record = await runSeatTickCheck(fixture.project, rig.deps);

  /* The fence is gone, and it is the SUCCESSOR that is woken, under a key of
     its own — never the stranded one replayed. */
  expect(rig.sent.map((message) => message.conversationId)).toEqual([successor.conversationId]);
  expect(rig.sent[0]!.clientMessageId).not.toBe(stranded.clientMessageId);
  expect(record).toMatchObject({ verdict: "wake" });
  expect(record!.delivery!.outcome).not.toBe("deferred-outstanding");

  /* The obligation is not dropped: same key, same payload, same landing plan,
     same dispatch record, now held against the seat that has been replaced and
     carrying the proof that licensed the move. */
  const retired = fixture.row().retiredWakes;
  expect(retired).toHaveLength(1);
  expect(retired[0]!.wake).toEqual({ ...stranded, preparedAt: retired[0]!.wake.preparedAt });
  expect(retired[0]!.wake).toMatchObject({ clientMessageId: stranded.clientMessageId, seatEpoch: 140, operationId: null,
    text: stranded.text, commit: stranded.commit, dispatch: { state: "refused" } });
  expect(retired[0]!.supersededBy).toEqual({ conversationId: successor.conversationId, seatEpoch: 155 });
  /* And the reason it stopped fencing is on the row, not inferred from the
     presence of a superseding seat (#1746). */
  expect(retired[0]!.reason).toBe("seat-superseded");
  expect(retired[0]!.retiredAt).toBe(new Date(fixture.now + 34 * 60 * MINUTE).toISOString());

  /* One journal line carries both facts: what the holder last answered, and
     that the attempt stopped withholding this project's wakes. */
  const retirement = rig.journal.find((line) => line.verdict === "retired")!;
  expect(retirement).toMatchObject({ seatEpoch: 140, delivery: { clientMessageId: stranded.clientMessageId, outcome: "uncertain" } });
  expect(retirement.detail).toContain("never re-sent");
  expect(retirement.detail).toContain("credits nothing");

  /* And the wait stays on the board under the attempt's own key, saying what
     it now does and does not block. */
  expect(rig.cards.map((entry) => entry.card)).toMatchObject([{ ref: SEAT_TICK_WAKE_UNRESOLVED_REF, kind: "wake-unresolved", instance: stranded.clientMessageId }]);
  expect(rig.cards[0]!.card.detail).toContain("no longer holds back this project's wakes");

  /* Nothing the stranded attempt named was credited on its behalf: the child it
     carried was still owed, so the wake the successor actually received is what
     harvested it. */
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* And the release is permanent, not one wake's reprieve. The holder still
     cannot account for the retired attempt, and the project's later checks are
     no longer withheld behind it. On main this project answered
     `deferred-outstanding` at +34 h, +48 h and +72 h with nothing sent. */
  for (const hours of [48, 72]) {
    const later = childRig(fixture, { realWakeState: true, seat: successor, now: fixture.now + hours * 60 * MINUTE });
    const record_ = await runSeatTickCheck(fixture.project, later.deps);
    expect(record_!.delivery?.outcome).not.toBe("deferred-outstanding");
    expect(fixture.row().retiredWakes).toHaveLength(1);
    expect(later.sent.map((message) => message.clientMessageId)).not.toContain(stranded.clientMessageId);
  }
});

/* The fence exists so two wakes are never in flight to ONE seat, and that is
   exactly as true after this change. Supersession takes positive proof, and
   each of these is the absence of it — so inside the attempt's own age bound
   every one of them is still fenced. */
test("the fence stands inside its bound wherever the payload could still reach the seat being woken (#1594)", async () => {
  const cases: [string, (fixture: ChildFixture) => { conversationId: string; seatEpoch: number; path: string | null } | null][] = [
    ["the seat has not moved at all", (fixture) => ({ ...fixture.seat, seatEpoch: 140 })],
    ["the same conversation is re-seated at a higher epoch", (fixture) => ({ ...fixture.seat, seatEpoch: 155 })],
    ["the seat file reads empty", () => null],
    ["the seat read has fallen behind the attempt's own epoch", (fixture) => ({ ...successorSeat(fixture, 139) })],
  ];
  for (const [name, seatFor] of cases) {
    const fixture = childFixture(`fence-holds-${name.replace(/[^a-z]+/g, "-")}`);
    setAgentRegistryForTests(fixture.registry);
    fixture.spawn({ title: "owed worker", turn: "terminal" });
    const stranded = await strandOneWake(fixture, 140);
    /* Resolved once: a case that mints a successor conversation must mint one,
       not one per read. */
    const seat = seatFor(fixture);
    /* Ninety minutes: past the wake interval, inside the two-interval bound. */
    const rig = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 90 * MINUTE });
    const record = await runSeatTickCheck(fixture.project, rig.deps);
    expect(rig.sent).toEqual([]);
    expect(fixture.row().retiredWakes).toEqual([]);
    expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: stranded.clientMessageId, seatEpoch: 140 });
    expect(rig.journal.some((line) => line.verdict === "retired")).toBe(false);
    if (seat) expect(record).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
    expect(fixture.acknowledged()).toEqual([]);

    /* And past the bound every one of them is retired unresolved on its age
       instead, because none of these readings will ever settle the attempt and
       a seat is not left unwoken for a second day waiting for one (#1746). The
       retirement is recorded with its reason wherever the seat read stands —
       even where there is no seat to wake, which is the one case that sends
       nothing. */
    const past = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 34 * 60 * MINUTE });
    const later = await runSeatTickCheck(fixture.project, past.deps);
    expect(fixture.row().outstandingWake).toBeNull();
    expect(fixture.row().retiredWakes).toMatchObject([{ wake: { clientMessageId: stranded.clientMessageId, seatEpoch: 140 }, supersededBy: null, reason: "unresolved-age" }]);
    expect(past.journal.some((line) => line.verdict === "retired")).toBe(true);
    if (seat) {
      expect(past.sent).toHaveLength(1);
      expect(past.sent[0]!.clientMessageId).not.toBe(stranded.clientMessageId);
      expect(later!.delivery!.outcome).toBe("delivered");
    } else {
      expect(past.sent).toEqual([]);
    }
  }
});

/* Retirement moves the obligation; it does not end it. Every check still asks
   the holder what became of it, and still asks for it back while the holder
   still has it. */
test("a retired attempt is asked after on every check and taken back the moment that becomes possible (#1594)", async () => {
  const entry = retiredEntry();
  const seat = { conversationId: SUCCESSOR, seatEpoch: 8, path: null };
  const state = { ...RECENT, seatEpoch: 8, retiredWakes: [entry] };

  const stuck = harness({ seat, pipelines: OPEN_LANE, state, wakeState: "retained", withdrawal: "unknown" });
  await runSeatTickCheck(PROJECT, stuck.deps);
  expect(stuck.withdrawn.map((call) => call.wake.clientMessageId)).toEqual([entry.wake.clientMessageId]);
  expect(stuck.withdrawn[0]!.reason).toContain("has since been replaced");
  expect(stuck.written.at(-1)!.retiredWakes).toEqual([entry]);
  expect(stuck.sent).toEqual([]);

  const taken = harness({ seat, pipelines: OPEN_LANE, state, wakeState: "retained", withdrawal: "withdrawn" });
  await runSeatTickCheck(PROJECT, taken.deps);
  const revocation = taken.journal.find((line) => line.verdict === "revoked")!;
  expect(revocation).toMatchObject({ seatEpoch: 7, delivery: { clientMessageId: entry.wake.clientMessageId, outcome: "withdrawn" } });
  expect(taken.written.at(-1)!.retiredWakes).toEqual([]);

  /* A holder that cannot answer at all proves nothing either way, so the
     obligation stands and the next check asks again. */
  const unreadable = harness({ seat, pipelines: OPEN_LANE, state, holderThrows: true });
  await runSeatTickCheck(PROJECT, unreadable.deps);
  expect(unreadable.written.at(-1)!.retiredWakes).toEqual([entry]);
});

/* The other half of retirement, and the one that keeps a replaced seat from
   acting for its successor: whatever the holder says became of the payload, it
   became of it on a seat this project no longer has. Nothing is credited. */
test("a retired attempt that lands afterwards credits nothing, and is never re-dispatched (#1594)", async () => {
  const fixture = childFixture("retired-landing-credits-nothing");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  const successor = successorSeat(fixture, 155);
  fixture.seed({
    seatEpoch: 155,
    eventsThrough: 12,
    lastWakeAt: new Date(fixture.now - 5 * MINUTE).toISOString(),
    retiredWakes: [{
      wake: { clientMessageId: "seat-tick:record:140:first:child-terminal:fp-1", conversationId: fixture.seat.conversationId,
        seatEpoch: 140, operationId: null, text: "the predecessor's wake", preparedAt: new Date(fixture.now - 70 * MINUTE).toISOString(),
        commit: { proposal: false, reasons: ["child-terminal"], fingerprint: "fp-1", eventsThrough: 99, children: [child.id] } },
      retiredAt: new Date(fixture.now - 65 * MINUTE).toISOString(),
      supersededBy: { conversationId: successor.conversationId, seatEpoch: 155 },
    }],
  });
  const rig = childRig(fixture, { seat: successor, wakeState: "landed" });
  await runSeatTickCheck(fixture.project, rig.deps);
  const landing = rig.journal.find((line) => line.verdict === "landed")!;
  expect(landing).toMatchObject({ seatEpoch: 140, delivery: { outcome: "landed" } });
  expect(landing.detail).toContain("no longer holds this project");
  /* The stamp, the cursor and the child it named: all exactly where they were,
     so the successor is still owed every one of them. */
  const row = fixture.row();
  expect(row.retiredWakes).toEqual([]);
  expect(row.eventsThrough).toBe(12);
  expect(row.lastWakeAt).toBe(new Date(fixture.now - 5 * MINUTE).toISOString());
  expect(fixture.acknowledged()).toEqual([]);
  expect(rig.sent).toEqual([]);
});

/* `absent` is the one answer that licenses an OUTSTANDING attempt to go out
   again under its original key. A retired one has nowhere to go: the seat it
   was prepared for is gone, so it is released unsent and the wake that leaves
   this check is the successor's own, under its own key. */
test("a retired attempt the holder affirms it never kept is released unsent, never replayed (#1594)", async () => {
  const entry = retiredEntry();
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 8, retiredWakes: [entry] },
    wakeState: "absent",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  const released = rig.journal.find((line) => line.verdict === "revoked")!;
  expect(released).toMatchObject({ seatEpoch: 7, delivery: { clientMessageId: entry.wake.clientMessageId, outcome: "unsent" } });
  expect(released.detail).toContain("never re-dispatched");
  expect(rig.written.at(-1)!.retiredWakes).toEqual([]);
  /* One wake left this check, and it was not the retired payload. */
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.clientMessageId).not.toBe(entry.wake.clientMessageId);
  expect(rig.sent[0]!.text).not.toBe(entry.wake.text);
  expect(record).toMatchObject({ verdict: "wake" });
});

/* A retired attempt still unresolved past the interval keeps the operator's
   attention, once, under its own key — and the card says what it now costs,
   which is nothing. */
test("a retired attempt outliving the wake interval is carded once, under its own key (#1594)", async () => {
  const entry = retiredEntry();
  const seat = { conversationId: SUCCESSOR, seatEpoch: 8, path: null };
  const rig = harness({ seat, pipelines: OPEN_LANE, state: { ...RECENT, seatEpoch: 8, retiredWakes: [entry] }, wakeState: "uncertain" });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.cards.map((raised) => raised.card)).toMatchObject([{ ref: SEAT_TICK_WAKE_UNRESOLVED_REF, kind: "wake-unresolved", instance: entry.wake.clientMessageId }]);
  expect(rig.cards[0]!.card.detail).toContain('last answered "uncertain"');
  expect(rig.cards[0]!.card.detail).toContain("never re-sent");
  expect(rig.cards[0]!.card.detail).toContain("no longer holds back this project's wakes");
  expect(rig.written.at(-1)!.retiredWakes).toEqual([entry]);
});

/* The bound. A row that has reached it refuses to retire another attempt and
   keeps the fence — which is the behaviour that stood before any of this, and
   the only direction that never discards an obligation to make room. */
test("a row at the retention bound keeps the fence rather than dropping an obligation (#1594)", async () => {
  const full = Array.from({ length: 20 }, (_, n) => retiredEntry({ clientMessageId: `retired-${n}` }));
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 8, outstandingWake: outstandingWake({ operationId: null }), retiredWakes: full },
    wakeState: "unknown",
    withdrawal: "unknown",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written.at(-1)!.retiredWakes).toHaveLength(20);
  expect(rig.written.at(-1)!.outstandingWake).toMatchObject({ clientMessageId: outstandingWake().clientMessageId });
  expect(rig.journal.some((line) => line.verdict === "retired")).toBe(false);
  expect(record).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
  expect(rig.sent).toEqual([]);
});

/* The journal is the audit trail an operator is pointed at, so the line this
   ending writes has to survive the journal it is written to. */
test("a retirement line reads back from the seat tick journal (#1594)", () => {
  const file = path.join(fs.mkdtempSync(path.join(SANDBOX, "journal-retired-")), "runs.ndjson");
  const record: SeatTickRunRecord = {
    schemaVersion: 1, at: new Date(NOW).toISOString(), project: PROJECT, seatEpoch: 140, verdict: "retired", reasons: [], items: 0, deferred: 0,
    eventsThrough: 3, delivery: { clientMessageId: "seat-tick:viewer:140:first:interval:fp-1", outcome: "uncertain" }, detail: "retired to a superseded seat",
  };
  appendSeatTickRecord(record, file);
  expect(readSeatTickRecords(10, file)).toEqual([record]);
});

/* The one way retirement could put two wakes in front of one seat: a seat
   re-designated BACK onto the conversation an earlier attempt was retired
   against. That conversation is the seat again, so the fence is owed to it
   again — and it is owed by the retired attempt, exactly as it would be by an
   outstanding one. */
test("a seat re-designated onto a conversation a retired attempt still names is fenced again (#1594)", async () => {
  const entry = retiredEntry();
  const rig = harness({
    /* The retired attempt's own conversation, seated again at a higher epoch. */
    seat: { conversationId: CONVERSATION, seatEpoch: 9, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 9, retiredWakes: [entry] },
    wakeState: "uncertain",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(rig.written.at(-1)!.retiredWakes).toEqual([entry]);

  /* And a project whose seat is anywhere else is not fenced by it. */
  const elsewhere = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 9, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 9, retiredWakes: [entry] },
    wakeState: "uncertain",
  });
  await runSeatTickCheck(PROJECT, elsewhere.deps);
  expect(elsewhere.sent).toHaveLength(1);
  expect(elsewhere.sent[0]!.conversationId).toBe(SUCCESSOR);
});

/* A board card is re-found by its ref alone, so while one ref served the whole
   project the first unresolved attempt to be carded took the only slot and
   every later one wrote nothing. Retirement makes a project able to hold
   several at once — and the shadowed one is the outstanding attempt, whose card
   is the one that says the project's wakes are held back (#1594). The project
   still carries ONE card, and it describes the attempt that fences the
   project, never the retired one standing beside it. This drives the real
   `ensureSeatTickCard` over a board file, because the shadowing lives there and
   the harness stub cannot see it. */
test("a retired and an outstanding attempt share one card, which names the outstanding one (#1594)", async () => {
  const project = `wake-cards-${crypto.randomUUID().slice(0, 8)}`;
  const board = path.join(process.env.LLV_STATE_DIR!, "tasks.json");
  const { loadTasks } = await import("@/lib/tasks/store");
  const cardsOn = (): { id: string; text: string; status: string }[] => loadTasks(board)
    .filter((task) => task.project === project && task.status !== "done");
  const stranded = outstandingWake({ seatEpoch: 140, conversationId: CONVERSATION, operationId: null,
    text: "the predecessor's wake", preparedAt: new Date(NOW - 70 * MINUTE).toISOString() });
  const lane = [{ ...OPEN_LANE[0]!, project }];
  const seat = { conversationId: SUCCESSOR, seatEpoch: 155, path: null };
  const shared = {
    seat, pipelines: lane, settings: defaultSeatTickSettings(project), wakeState: "unknown" as const,
    /* A send the layer took and has not landed: the successor's own attempt
       becomes the outstanding one, and the retired one is still unresolved. */
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-successor-1", receipt: {} as never, structured: true } as DeliveryOutcome,
    state: { seatEpoch: 155, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), outstandingWake: stranded },
  };

  /* Check one retires the predecessor's attempt, cards it, and raises the
     successor's own wake — which the layer keeps. */
  const first = harness(shared);
  await runSeatTickCheck(project, { ...first.deps, ensureCard: undefined });
  expect(first.sent).toHaveLength(1);
  const successorKey = first.sent[0]!.clientMessageId!;
  expect(cardsOn()).toHaveLength(1);

  /* Check two, past the interval: the successor's attempt is now unresolved
     too, and it must reach the board rather than be shadowed. */
  const second = harness({ ...shared, now: NOW + 61 * MINUTE,
    state: { ...shared.state, outstandingWake: undefined as never } });
  second.deps.readState = first.deps.readState;
  second.deps.writeState = first.deps.writeState;
  const record = await runSeatTickCheck(project, { ...second.deps, ensureCard: undefined });
  expect(record).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });

  const standing = cardsOn();
  expect(standing).toHaveLength(1);
  const card = standing[0]!;
  /* It names the attempt holding the project's wakes, and says so. */
  expect(card.text).toContain(successorKey);
  expect(card.text).toContain("dispatches no replacement wake");
  expect(card.text).toContain(`monitor-ref: ${SEAT_TICK_WAKE_UNRESOLVED_REF}`);
  expect(card.text).toContain("Attempts on this card: 2");

  /* A later check inside the attempt's age bound re-raises the same
     condition and writes nothing. */
  const third = harness({ ...shared, now: NOW + 90 * MINUTE, state: { ...shared.state, outstandingWake: undefined as never } });
  third.deps.readState = first.deps.readState;
  third.deps.writeState = first.deps.writeState;
  await runSeatTickCheck(project, { ...third.deps, ensureCard: undefined });
  expect(cardsOn()).toEqual(standing);
});

/* The retired release on affirmed absence, pinned across every dispatch state
   it can meet — the one place the retired reconcile is deliberately less
   conservative than the outstanding one, which fences a token and releases only
   an explicit refusal. It can be: the admission fence claims
   `state.outstandingWake`, so no transport call can ever start under a retired
   attempt and there is no token left to fence. What still has to hold is the
   other half — an attempt whose transport call has NOT come back is kept,
   because that call is the one thing that could still be happening, and an
   attempt naming an operation is kept, because absence beside a handle is not
   an affirmation about that handle. */
test("the retired release on affirmed absence turns on the transport call, never on age (#1594)", async () => {
  const cases: [string, SeatTickOutstandingWake["dispatch"], string | null, boolean][] = [
    ["a refusal that reserved nothing", { token: "dispatch-token", state: "refused" }, null, true],
    ["a call that returned without refusing", { token: "dispatch-token", state: "returned" }, null, true],
    ["a legacy attempt with no dispatch record", undefined, null, true],
    ["a call that has not come back", { token: "dispatch-token", state: "active" }, null, false],
    ["an attempt that still names an operation", { token: "dispatch-token", state: "refused" }, "op-retired-1", false],
  ];
  for (const [name, dispatch, operationId, released] of cases) {
    const entry = retiredEntry({ clientMessageId: `retired-${name.replace(/[^a-z]+/g, "-")}`, dispatch, operationId });
    const rig = harness({
      seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
      pipelines: OPEN_LANE,
      state: { ...RECENT, seatEpoch: 8, retiredWakes: [entry] },
      wakeState: "absent",
    });
    await runSeatTickCheck(PROJECT, rig.deps);
    const unsent = rig.journal.find((line) => line.delivery?.clientMessageId === entry.wake.clientMessageId && line.delivery.outcome === "unsent");
    expect([name, rig.written.at(-1)!.retiredWakes.length]).toEqual([name, released ? 0 : 1]);
    expect([name, unsent !== undefined]).toEqual([name, released]);
    /* Released or kept, the payload never goes out again under any key. */
    expect(rig.sent).toEqual([]);
  }
});

/* The two answers the retired reconcile can meet that nothing else exercises.
   `dropped` is the one verdict that ends an obligation on the holder's word
   alone, and `too-late` is the answer the whole withdrawal mechanism exists to
   be able to give — the replaced seat may have received it. */
test("a retired attempt the holder proves it never delivered is ended, and one it was already past is kept (#1594)", async () => {
  const seat = { conversationId: SUCCESSOR, seatEpoch: 8, path: null };

  /* Proven non-delivery ends the obligation, and credits nothing on the way
     out: the successor was never told, so everything it named is still owed. */
  const dropped = retiredEntry({ clientMessageId: "retired-dropped" });
  const ended = harness({
    seat, pipelines: OPEN_LANE,
    state: { ...RECENT, seatEpoch: 8, eventsThrough: 12, retiredWakes: [dropped] },
    wakeState: "dropped",
  });
  await runSeatTickCheck(PROJECT, ended.deps);
  const line = ended.journal.find((entry) => entry.delivery?.clientMessageId === dropped.wake.clientMessageId)!;
  expect(line).toMatchObject({ verdict: "dropped", seatEpoch: 7, delivery: { outcome: "dropped" } });
  expect(line.detail).toContain("remain owed");
  expect(ended.written.at(-1)!.retiredWakes).toEqual([]);
  expect(ended.written.at(-1)!.eventsThrough).toBe(12);
  expect(ended.written.at(-1)!.lastWakeAt).toBe(RECENT.lastWakeAt);
  expect(ended.sent).toEqual([]);

  /* A holder already past the point of taking it back settles nothing: the
     replaced seat may have it, so the attempt is kept and asked again. The
     board is what carries that, once — a keep-verdict line per retained
     attempt per check would spend the journal's history on repetition. */
  const late = retiredEntry({ clientMessageId: "retired-too-late" });
  const kept = harness({
    seat, pipelines: OPEN_LANE,
    state: { ...RECENT, seatEpoch: 8, retiredWakes: [late] },
    wakeState: "retained", withdrawal: "too-late",
  });
  await runSeatTickCheck(PROJECT, kept.deps);
  expect(kept.withdrawn.map((call) => call.wake.clientMessageId)).toEqual([late.wake.clientMessageId]);
  expect(kept.written.at(-1)!.retiredWakes).toEqual([late]);
  expect(kept.journal.some((entry) => entry.delivery?.clientMessageId === late.wake.clientMessageId)).toBe(false);
  expect(kept.cards.map((raised) => raised.card.instance)).toEqual([late.wake.clientMessageId]);
  expect(kept.cards[0]!.card.detail).toContain('last answered "retained"');
  expect(kept.sent).toEqual([]);
});

test("a late Claude confirmation closes a retired wake under its original key without sending or crediting it", async () => {
  const { fixture, operationId, wake, rig } = await strandedManagerWake("late-confirmed-retired-wake");
  const retirement = {
    wake, retiredAt: ago(fixture, 1), supersededBy: null, reason: "unresolved-age" as const,
  };
  fixture.seed({ outstandingWake: null, retiredWakes: [retirement], lastWakeAt: ago(fixture, 1), eventsThrough: 12 });
  const lastWakeAt = fixture.row().lastWakeAt;
  const settings = { ...defaultSeatTickSettings(fixture.project), enabled: false, reason: "Reconcile without a fresh wake." };
  const session = fixture.registry.conversation(fixture.seat.conversationId as never)!.generations[0]!.id;
  const ledger = new FileClaudeDeliveryLedger();
  ledger.recordQueued(session, { id: operationId, text: wake.text }, "turn-started");
  const before = rig(12, { settings });
  await runSeatTickCheck(fixture.project, before.deps);
  expect(fixture.row().retiredWakes).toEqual([retirement]);
  expect(before.sent).toEqual([]);

  ledger.confirmDelivered(session, operationId, "late-wake-message");
  const later = rig(13, { settings });
  await runSeatTickCheck(fixture.project, later.deps);
  expect(later.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: wake.clientMessageId, outcome: "landed" } });
  expect(later.journal[0]!.detail).toContain("Claude delivery ledger confirms the original operation");
  expect(later.journal[0]!.detail).not.toContain("settled delivered on the journal's own verdict");
  expect(fixture.row()).toMatchObject({ outstandingWake: null, retiredWakes: [], lastWakeAt, eventsThrough: 12 });
  expect(fixture.acknowledged()).toEqual([]);
  expect(later.sent).toEqual([]);
});

test("a wake the settlement ended unrecorded fences inside its bound, the board names the operation, the record's reason and the journal's silence, and the bound is what ends it (#1746)", async () => {
  const { fixture, journal, child, operationId, wake, fenced } = await strandedManagerWake("stranded-manager");
  expect(fenced.journal.map((line) => line.verdict)).toEqual(["uncertain", "wake"]);
  /* The same obligations raise the same key, and the key waits behind itself. */
  expect(fenced.journal[1]).toMatchObject({ delivery: { clientMessageId: wake.clientMessageId, outcome: "deferred-outstanding" } });
  expect(fenced.sent).toEqual([]);
  const cards = fenced.cards.map(({ card }) => card);
  expect(cards).toMatchObject([{ ref: SEAT_TICK_WAKE_UNRESOLVED_REF, kind: "wake-unresolved", instance: wake.clientMessageId }]);
  /* The diagnosis an operator can act on: which operation the record holds
     under the key, what the record says of it, and what the journal answered. */
  expect(cards[0]!.detail).toContain('last answered "uncertain"');
  expect(cards[0]!.detail).toContain(`operation ${operationId}`);
  expect(cards[0]!.detail).toContain("failed, unverified");
  expect(cards[0]!.detail).toContain("journal holds no record");
  expect(cards[0]!.detail).toContain("dispatches no replacement wake");
  expect(fenced.journal[0]!.detail).toContain(`operation ${operationId}`);
  expect(fenced.journal[0]!.detail).toContain("journal holds no record");

  /* Inside the bound, age settles nothing and a restart settles nothing: the
     row, the key and the payload are exactly what they were, and the card is
     raised once. */
  const before = JSON.stringify(frozen(fixture));
  for (const minutes of [16, 61, 119]) {
    const later = childRig(fixture, { realWakeState: true, journal, now: fixture.now + minutes * MINUTE });
    expect(await runSeatTickCheck(fixture.project, later.deps)).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
    expect(later.sent).toEqual([]);
    expect(later.journal.map((line) => line.verdict)).toEqual(["uncertain", "wake"]);
    expect(JSON.stringify(frozen(fixture))).toBe(before);
    expect(later.cards.map(({ card }) => card.instance)).toEqual([wake.clientMessageId]);
  }
  expect(fixture.acknowledged()).toEqual([]);

  /* Past it, nothing about the evidence has improved and nothing ever will:
     the record absorbed the key, the journal holds no record of the operation,
     and absence is not proof. This is the #1672 shape, and what ends it is the
     bound (#1746) — the attempt retired unresolved, the obligations it named
     re-derived, and the seat woken by the same check. */
  const spent = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 2 * 24 * 60 * MINUTE });
  const woken = await runSeatTickCheck(fixture.project, spent.deps);
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(spent.sent).toHaveLength(1);
  expect(spent.sent[0]!.clientMessageId).not.toBe(wake.clientMessageId);
  expect(spent.journal.map((line) => line.verdict)).toEqual(["retired", "wake"]);
  expect(spent.journal[0]!.detail).toContain("retired unresolved on its age bound");
  expect(fixture.row().outstandingWake).toBeNull();
  expect(fixture.row().retiredWakes).toMatchObject([{ supersededBy: null, reason: "unresolved-age" }]);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a journal answer that proves nothing keeps the fence: a late admission the queue fenced, and an old host's unverified failure", async () => {
  for (const answer of [
    { status: "uncertain" as const, reason: DELIVERY_FENCED_BY_SETTLEMENT, expected: "journal: uncertain" },
    { status: "failed" as const, reason: SEND_UNVERIFIED_REASON, expected: "journal: failed" },
  ]) {
    const { fixture, journal, operationId, wake } = await strandedManagerWake(`stranded-${answer.status}`);
    journal.operations.set(operationId, { status: answer.status, reason: answer.reason });
    const before = JSON.stringify(frozen(fixture));
    const later = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 16 * MINUTE });
    expect(await runSeatTickCheck(fixture.project, later.deps)).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
    expect(later.sent).toEqual([]);
    expect(later.journal[0]).toMatchObject({ verdict: "uncertain", delivery: { clientMessageId: wake.clientMessageId, outcome: "uncertain" } });
    expect(later.journal[0]!.detail).toContain(answer.expected);
    expect(JSON.stringify(frozen(fixture))).toBe(before);
    expect(fixture.acknowledged()).toEqual([]);
  }
});

test("the journal's own terminal verdict outranks a record settled without it: rejected releases the fence and the next wake goes out", async () => {
  for (const answer of [
    { status: "rejected" as const, reason: "conversation is not hosted by any structured host" },
    { status: "failed" as const, reason: SEND_DISCARDED_REASON },
  ]) {
    const { fixture, journal, child, operationId, wake } = await strandedManagerWake(`released-${answer.status}`);
    journal.operations.set(operationId, { status: answer.status, reason: answer.reason });
    /* The transport as it behaves on the re-raise: the same key reaches the
       delivery layer, which re-arms the reservation only because the record
       now says the first attempt was lost. */
    const rearmed: string[] = [];
    const released = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 16 * MINUTE, deliverWith: async (message) => {
      const held = fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, SEAT_TICK_COMMAND as never);
      rearmed.push(held.state);
      fixture.registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
      return { ok: true, target: "structured", outcome: "delivered", structured: true };
    } });
    const record = await runSeatTickCheck(fixture.project, released.deps);
    /* Proven never executed: the record is settled lost on the journal's word,
       the attempt is released under its key, and the same check raises the
       wake again — the same obligations under a NEW key, because the old one
       is spent in the journal that refused it (#1672). */
    expect(released.journal[0]).toMatchObject({ verdict: "dropped", delivery: { clientMessageId: wake.clientMessageId, outcome: "dropped" } });
    expect(released.journal[0]!.detail).toContain(`operation ${operationId}`);
    expect(released.journal[0]!.detail).toContain("settled lost on the journal's own verdict");
    expect(fixture.registry.readOnlySnapshot().deliveryOperationOwners[operationId]).toMatchObject({ terminalDisposition: "lost" });
    expect(rearmed).toEqual(["assigned"]);
    expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
    expect(record!.delivery!.clientMessageId).not.toBe(wake.clientMessageId);
    expect(record!.delivery!.clientMessageId.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
    expect(fixture.row().releasedWake).toBeNull();
    expect(released.sent).toHaveLength(1);
    expect(released.sent[0]!.text).toContain(child.id);
    expect(fixture.row()).toMatchObject({ outstandingWake: null, lastWakeAt: new Date(fixture.now + 16 * MINUTE).toISOString() });
    expect(fixture.acknowledged()).toEqual([child.id]);
  }
});

test("a journal verdict the record cannot take still releases: a reservation compacted to its owner row is not what the replacement needs", async () => {
  const { fixture, journal, child, operationId, wake } = await strandedManagerWake("released-compacted");
  journal.operations.set(operationId, { status: "rejected", reason: "conversation is not hosted by any structured host" });
  /* The reservation is gone; only the owner row remembers the send. */
  const registry = fixture.registry as unknown as { mutate<R>(fn: (file: { heldDeliveries: Record<string, unknown> }) => R): R };
  registry.mutate((file) => { for (const [id, row] of Object.entries(file.heldDeliveries)) if ((row as { command: { operationId: string } }).command.operationId === operationId) delete file.heldDeliveries[id]; });
  const later = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 16 * MINUTE });
  const record = await runSeatTickCheck(fixture.project, later.deps);
  expect(later.journal[0]).toMatchObject({ verdict: "dropped", delivery: { clientMessageId: wake.clientMessageId, outcome: "dropped" } });
  expect(later.journal[0]!.detail).toContain("could not take the journal's verdict");
  /* The owner row keeps its own answer; the replacement never asks it. */
  expect(fixture.registry.readOnlySnapshot().deliveryOperationOwners[operationId]).toMatchObject({ terminalDisposition: "unverified" });
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "delivered" } });
  expect(record!.delivery!.clientMessageId.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a replacement released in its turn is raised under a third key, distinct from both before it (#1672)", async () => {
  const { fixture, journal, operationId, wake } = await strandedManagerWake("released-twice");
  journal.operations.set(operationId, { status: "rejected", reason: "conversation is not hosted by any structured host" });
  /* The replacement is admitted and queued, never landing. */
  const admitted: string[] = [];
  const queuedTransport = async (message: ConversationMessage): Promise<DeliveryOutcome> => {
    const held = fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, SEAT_TICK_COMMAND as never);
    fixture.registry.beginDeliveryAttempt(held.id, held.generationId!);
    journal.operations.set(held.command.operationId, { status: "queued", reason: null });
    admitted.push(held.command.operationId);
    return { ok: true, target: "structured", outcome: "queued", structured: true, operationId: held.command.operationId };
  };
  /* The settlement reads the wall clock the record stamps with, so the
     replacement's fresh reservation is judged by its real age. */
  const live = () => Date.now();
  const first = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 16 * MINUTE, settlementNow: live, deliverWith: queuedTransport });
  await runSeatTickCheck(fixture.project, first.deps);
  const second = fixture.row().outstandingWake!;
  expect(second.clientMessageId.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
  expect(second.operationId).toBe(admitted[0]!);
  /* The host rejects the replacement too. */
  journal.operations.set(admitted[0]!, { status: "rejected", reason: "conversation is not hosted by any structured host" });
  const again = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 21 * MINUTE, settlementNow: live, deliverWith: queuedTransport });
  await runSeatTickCheck(fixture.project, again.deps);
  expect(again.journal[0]).toMatchObject({ verdict: "dropped", delivery: { clientMessageId: second.clientMessageId, outcome: "dropped" } });
  const third = fixture.row().outstandingWake!;
  expect(third.clientMessageId).not.toBe(wake.clientMessageId);
  expect(third.clientMessageId).not.toBe(second.clientMessageId);
  expect(third.clientMessageId.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
  expect(fixture.row().releasedWake).toMatchObject({ clientMessageId: second.clientMessageId });
  expect(admitted).toHaveLength(2);
  expect(fixture.acknowledged()).toEqual([]);
});

test("a delivery whose terminal acknowledgement the record never received lands on the journal's word, on the plan the raising check wrote", async () => {
  const { fixture, journal, child, operationId, wake } = await strandedManagerWake("landed-by-journal");
  journal.operations.set(operationId, { status: "delivered", reason: null });
  const landed = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 16 * MINUTE });
  const readWakeState = landed.deps.sources!.wakeState;
  let actualDeliveryAt: string | null = null;
  landed.deps.sources!.wakeState = async pending => {
    const result = await readWakeState(pending);
    if (typeof result !== "string") actualDeliveryAt = result.evidence?.record?.settledAt ?? null;
    return result;
  };
  const record = await runSeatTickCheck(fixture.project, landed.deps);
  expect(landed.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: wake.clientMessageId, outcome: "landed" } });
  expect(landed.journal[0]!.detail).toContain("settled delivered on the journal's own verdict");
  expect(fixture.registry.readOnlySnapshot().deliveryOperationOwners[operationId]).toMatchObject({ terminalState: "delivered", terminalDisposition: "delivered" });
  expect(actualDeliveryAt).not.toBeNull();
  expect(fixture.row()).toMatchObject({ outstandingWake: null, lastWakeAt: actualDeliveryAt });
  expect(actualDeliveryAt).not.toBe(new Date(fixture.now + 16 * MINUTE).toISOString());
  expect(fixture.acknowledged()).toEqual([child.id]);
  /* Credited, so the same check has nothing left to raise. */
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(landed.sent).toEqual([]);
});

test("a send the host admitted and rejected outright is released in the same check, whatever disposition the record kept", async () => {
  const fixture = childFixture("admitted-rejected");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const journal = fakeJournal();
  const rig = childRig(fixture, { realWakeState: true, journal, deliverWith: admittedAndRejected(fixture, journal, "conversation is not hosted by any structured host") });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "failed" } });
  /* The reconcile that follows the send reads the journal's `rejected` past
     the record's unverified failure: released, nothing credited. */
  expect(rig.journal.map((line) => line.verdict)).toEqual(["dropped", "wake"]);
  expect(fixture.row()).toMatchObject({ outstandingWake: null, lastWakeAt: ago(fixture, 61) });
  expect(fixture.acknowledged()).toEqual([]);
  /* The next check — a fresh controller — raises it again and it lands. */
  const next = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 5 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, next.deps)).toMatchObject({ verdict: "wake", delivery: { outcome: "delivered" } });
  expect(next.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("the permitted recovery for the stranded shape is supersession: the attempt retires whole and the successor is woken (#1594)", async () => {
  const { fixture, journal, child, wake } = await strandedManagerWake("stranded-superseded");
  const successor = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  const seat = { conversationId: successor.id, seatEpoch: 8, path: successor.generations[0]!.path };
  const next = childRig(fixture, { realWakeState: true, journal, seat, now: fixture.now + 16 * MINUTE });
  await runSeatTickCheck(fixture.project, next.deps);
  expect(next.journal[0]).toMatchObject({ verdict: "retired", delivery: { clientMessageId: wake.clientMessageId, outcome: "uncertain" } });
  /* Key, payload, plan and dispatch record travel untouched; only the fence ends. */
  expect(fixture.row().retiredWakes.map((entry) => entry.wake)).toEqual([wake]);
  expect(fixture.row().retiredWakes[0]!.supersededBy).toEqual({ conversationId: successor.id, seatEpoch: 8 });
  expect(fixture.row().outstandingWake).toBeNull();
  expect(next.sent).toHaveLength(1);
  expect(next.sent[0]!.conversationId).toBe(successor.id);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a released wake is raised again as a new message the journal admits, through the real transport, and lands exactly once (#1672)", async () => {
  const fixture = childFixture("released-real-transport");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const { journal, client } = hostedSeat(fixture);
  try {
    /* The send that timed out after the reservation, and the deadline that
       ended it unrecorded — the same shape as the live row. */
    let operationId = "";
    await runSeatTickCheck(fixture.project, childRig(fixture, { realWakeState: true, journal: { client }, deliverWith: reservedThenTimedOut(fixture, (id) => { operationId = id; }) }).deps);
    const wake = fixture.row().outstandingWake!;
    const fenced = childRig(fixture, { realWakeState: true, journal: { client }, now: fixture.now + 11 * MINUTE });
    await runSeatTickCheck(fixture.project, fenced.deps);
    expect(fenced.journal.map((line) => line.verdict)).toEqual(["uncertain", "wake"]);
    expect(fixture.registry.readOnlySnapshot().deliveryOperationOwners[operationId]).toMatchObject({ terminalDisposition: "unverified" });

    /* The host admits the command late, under the identity the record bound,
       and rejects it. The journal now owns (conversation, key). */
    const command = {
      kind: "send" as const, operationId, conversationId: wake.conversationId, idempotencyKey: wake.clientMessageId,
      text: wake.text!, contentDigest: structuredContentDigest({ text: wake.text!, images: [] }), policy: "interrupt-active" as const,
    };
    expect(journal.executeOperation(command).replayed).toBe(false);
    journal.transitionOperation(operationId, "rejected", { reason: "conversation is not hosted by any structured host" });
    /* Why the re-raise cannot be the same message: the journal answers the
       identical command by replaying the refusal, and a changed one under
       that key by refusing it outright. */
    expect(journal.executeOperation(command)).toMatchObject({ replayed: true, receipt: { status: "rejected" } });
    const changed = `${wake.text!} (edited)`;
    expect(() => journal.executeOperation({ ...command, text: changed, contentDigest: structuredContentDigest({ text: changed, images: [] }) }))
      .toThrow("idempotency key already belongs to another request");

    /* The release, and the re-raise through the real transport. */
    /* From here the settlement reads the wall clock the record stamps with,
       so the replacement's own reservation is judged by its real age. */
    const live = () => Date.now();
    const released = childRig(fixture, { realWakeState: true, journal: { client }, now: fixture.now + 16 * MINUTE, settlementNow: live, deliverWith: realTransport(fixture, client) });
    const record = await runSeatTickCheck(fixture.project, released.deps);
    expect(released.journal.map((line) => line.verdict)).toEqual(["dropped", "wake"]);
    expect(released.journal[0]).toMatchObject({ verdict: "dropped", delivery: { clientMessageId: wake.clientMessageId, outcome: "dropped" } });
    expect(fixture.registry.readOnlySnapshot().deliveryOperationOwners[operationId]).toMatchObject({ terminalDisposition: "lost" });
    expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "queued" } });
    const replacement = fixture.row().outstandingWake!;
    expect(replacement.clientMessageId).not.toBe(wake.clientMessageId);
    expect(replacement.clientMessageId.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
    expect(replacement.operationId).not.toBeNull();
    expect(replacement.operationId).not.toBe(operationId);
    expect(fixture.row().releasedWake).toMatchObject({ clientMessageId: wake.clientMessageId });
    /* Two operations in the journal — the refused one and the replacement —
       and exactly one pending effect, the replacement's. */
    expect(journal.operationResult(operationId)?.receipt.status).toBe("rejected");
    expect(journal.operationResult(replacement.operationId!)?.receipt).toMatchObject({ status: "queued", idempotencyKey: replacement.clientMessageId });
    expect(journal.effectBatch(100, ["runtime.send"]).map((effect) => effect.payload.operationId)).toEqual([replacement.operationId]);
    expect(fixture.acknowledged()).toEqual([]);

    /* A check while it is queued replays nothing and sends nothing. */
    const waiting = childRig(fixture, { realWakeState: true, journal: { client }, now: fixture.now + 21 * MINUTE, settlementNow: live, deliverWith: realTransport(fixture, client) });
    expect(await runSeatTickCheck(fixture.project, waiting.deps)).toMatchObject({ delivery: { clientMessageId: replacement.clientMessageId, outcome: "deferred-outstanding" } });
    expect(waiting.sent).toEqual([]);
    expect(journal.snapshot().recentOperations).toHaveLength(2);

    /* The drain delivers it; the next check credits the plan and clears the marker. */
    journal.transitionOperation(replacement.operationId!, "delivered");
    const landed = childRig(fixture, { realWakeState: true, journal: { client }, now: fixture.now + 26 * MINUTE, settlementNow: live, deliverWith: realTransport(fixture, client) });
    expect(await runSeatTickCheck(fixture.project, landed.deps)).toMatchObject({ verdict: "quiet" });
    expect(landed.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: replacement.clientMessageId, outcome: "landed" } });
    expect(fixture.row()).toMatchObject({ outstandingWake: null, releasedWake: null, lastWakeAt: new Date(fixture.now + 26 * MINUTE).toISOString() });
    expect(fixture.acknowledged()).toEqual([child.id]);
    expect(landed.sent).toEqual([]);
    expect(journal.snapshot().recentOperations).toHaveLength(2);
  } finally {
    journal.close();
  }
});

test("a wake waits out the seat's running turn instead of interrupting it, and reaches the seat once, when it is idle", async () => {
  const fixture = childFixture("busy-seat-wake");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const { journal, client } = hostedSeat(fixture);
  /* The seat's host as the delivery queue sees it: a turn the operator
     started is running when the queue reaches the wake. */
  const seatHost: HostState = {
    status: "active", sessionKey: "seat-session", endpoint: "fixture:seat-host", pid: 1, processStartIdentity: "fixture:1",
    eventCursor: 0, protocolVersion: "fixture-v1", activeTurnRef: "turn:operator", pendingAttention: [], activeFlags: [], account: null,
  };
  const ledger = createFakeDeliveryLedger();
  let interrupts = 0;
  class SeatHost extends FakeEngineHost {
    override async interrupt(): Promise<void> { interrupts += 1; }
  }
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
    status: async (id) => journal.operationResult(id)?.receipt ?? null,
    settled: () => false,
  }, () => new SeatHost(ledger, seatHost));
  const live = () => Date.now();
  try {
    const raised = childRig(fixture, { realWakeState: true, journal: { client }, settlementNow: live, deliverWith: realTransport(fixture, client) });
    expect(await runSeatTickCheck(fixture.project, raised.deps)).toMatchObject({ verdict: "wake", delivery: { outcome: "queued" } });
    const wake = fixture.row().outstandingWake!;
    expect(wake.operationId).not.toBeNull();
    expect(journal.effectBatch(100, ["runtime.send"]).map((effect) => effect.payload.policy)).toEqual(["queue"]);

    await queue.drain();
    expect(interrupts).toBe(0);
    expect(ledger.writes).toEqual([]);
    expect(journal.operationResult(wake.operationId!)?.receipt.status).toBe("queued");
    /* A check while the turn runs sends nothing and keeps the same wake. */
    const busy = childRig(fixture, { realWakeState: true, journal: { client }, now: fixture.now + 5 * MINUTE, settlementNow: live, deliverWith: realTransport(fixture, client) });
    await runSeatTickCheck(fixture.project, busy.deps);
    expect(busy.sent).toEqual([]);
    expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: wake.clientMessageId, operationId: wake.operationId });

    /* The turn ends; the next pass hands the wake over, once, under its key. */
    Object.assign(seatHost, { status: "idle", activeTurnRef: null });
    await queue.drain();
    await queue.drain();
    expect(interrupts).toBe(0);
    expect(ledger.writes.map((entry) => entry.id)).toEqual([wake.operationId!]);
    expect(journal.operationResult(wake.operationId!)?.receipt).toMatchObject({ status: "delivered", idempotencyKey: wake.clientMessageId });
    const landed = childRig(fixture, { realWakeState: true, journal: { client }, now: fixture.now + 10 * MINUTE, settlementNow: live, deliverWith: realTransport(fixture, client) });
    await runSeatTickCheck(fixture.project, landed.deps);
    expect(landed.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: wake.clientMessageId, outcome: "landed" } });
    expect(landed.sent).toEqual([]);
    expect(fixture.acknowledged()).toEqual([child.id]);
  } finally {
    journal.close();
  }
});

/* ------------------------------------------------------------------------- *
 * The bound on the fence (#1746).
 *
 * What #1672 recorded: a seat enabled, checked every five minutes, computing
 * `wake` every time, and mute for three and a half hours behind one attempt
 * whose delivery no evidence could ever prove either way. The protection was
 * heavier than the harm — a wake that arrives twice costs one redundant turn,
 * because the seat re-derives everything it acts on from bounded reads; a wake
 * that never arrives stops the conveyor.
 *
 * Every case below runs on this test's own copy of the state a check reads —
 * its own registry, its own row, its own delivery record, its own runtime
 * journal, in its own sandbox — and never the live ones.
 * ------------------------------------------------------------------------- */

/* The shape from the comment of 2026-09-18, rebuilt: seat epoch 169 on a
   twenty-minute cadence, a key derived from a wake eight days and eight epochs
   old, a record that reads failed and unverified for ever, and a runtime
   journal that has been compacted past the operation. The acceptance this
   whole issue is measured by: the first check after the bound delivers. */
test("the #1672 shape — a key anchored eight days back that no evidence can settle — is retired on its bound and the first check past it delivers a wake (#1746)", async () => {
  const anchor = new Date(Date.now() + 3 * MINUTE - 8 * 24 * 60 * MINUTE).toISOString();
  const { fixture, child, wake, rig } = await strandedManagerWake("fence-bound-1672-shape", {
    seatEpoch: 169, lastWakeAt: anchor, wakeIntervalMinutes: 20,
  });
  /* The key carries the stale anchor, which is how one unresolved original key
     outlived eight rotations: it is derived from the last PROVEN wake. */
  expect(wake.clientMessageId).toContain(`:${anchor}:`);
  expect(wake).toMatchObject({ seatEpoch: 169, operationId: null, dispatch: { state: "refused" } });

  /* Inside the bound — one hour, the floor under two twenty-minute intervals —
     every check still computes `wake` and still sends nothing, which is the
     no-blind-resend rule this issue keeps. What is new is that the line says
     why it is mute: which key, since when, and when the fence lapses. */
  for (const minutes of [21, 41, 59]) {
    const inside = rig(minutes);
    const deferred = await runSeatTickCheck(fixture.project, inside.deps);
    expect(deferred).toMatchObject({ verdict: "wake", delivery: { clientMessageId: wake.clientMessageId, outcome: "deferred-outstanding" } });
    expect(inside.sent).toEqual([]);
    expect(deferred!.detail).toContain("this tick is fenced by the wake prepared");
    expect(deferred!.detail).toContain(`under key ${wake.clientMessageId}`);
    expect(deferred!.detail).toContain(`the fence lapses at ${new Date(fixture.now + 60 * MINUTE).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: wake.clientMessageId });
    expect(fixture.acknowledged()).toEqual([]);
  }

  /* The bound spent: retired unresolved, recorded with its reason, and the
     seat woken by the same check — under a key of its own, never the fenced one
     replayed, because that key is still bound in the layers that refused it. */
  const past = rig(61);
  const woken = await runSeatTickCheck(fixture.project, past.deps);
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(past.sent).toHaveLength(1);
  expect(past.sent[0]!.clientMessageId).not.toBe(wake.clientMessageId);
  expect(past.sent[0]!.clientMessageId!.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
  /* And the obligations the retired attempt carried are in it, credited once,
     by the wake that actually went out. */
  expect(past.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(fixture.row()).toMatchObject({ outstandingWake: null });
  expect(fixture.row().retiredWakes).toMatchObject([{ wake: { clientMessageId: wake.clientMessageId, seatEpoch: 169 }, supersededBy: null, reason: "unresolved-age" }]);
  const retirement = past.journal.find((line) => line.verdict === "retired")!;
  expect(retirement).toMatchObject({ delivery: { clientMessageId: wake.clientMessageId } });
  expect(retirement.detail).toContain("retired unresolved on its age bound");
  expect(retirement.detail).toContain("never re-sent");
  expect(retirement.detail).toContain("every obligation it named is still owed and the next check derives its own wake from them");
});

/* The rule the bound may not break: one wake in flight per seat. The wake that
   replaces a retired attempt can end the same way the first one did, and then
   it is the fence — under its own key, for its own bound. */
test("the wake that replaces an attempt retired on its age is the project's only one in flight (#1746)", async () => {
  const { fixture, journal, wake, rig } = await strandedManagerWake("fence-bound-one-in-flight", { wakeIntervalMinutes: 20 });
  let replacementOperation = "";
  const past = rig(61, { deliverWith: reservedThenTimedOut(fixture, (id) => { replacementOperation = id; }) });
  await runSeatTickCheck(fixture.project, past.deps);
  expect(past.sent).toHaveLength(1);
  const replacement = fixture.row().outstandingWake!;
  expect(replacement.clientMessageId).not.toBe(wake.clientMessageId);
  expect(fixture.row().retiredWakes).toMatchObject([{ reason: "unresolved-age" }]);

  /* The replacement's own send was reserved and lost the same way. Two checks
     later, nothing has gone out beside it: the row carries one prepared
     attempt, and it is the replacement's. */
  for (const minutes of [66, 75]) {
    const after = rig(minutes);
    const deferred = await runSeatTickCheck(fixture.project, after.deps);
    expect(after.sent).toEqual([]);
    expect(deferred!.delivery).toMatchObject({ clientMessageId: replacement.clientMessageId, outcome: "deferred-outstanding" });
    expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: replacement.clientMessageId });
    expect(fixture.row().retiredWakes).toHaveLength(1);
  }
  /* The retired attempt is never re-sent under any key, and the replacement is
     never sent twice. */
  expect(journal.transitions.filter((entry) => entry.operationId === replacementOperation)).toHaveLength(0);

  /* And the replacement's own bound is its own: measured from when IT was
     prepared, it retires an hour after that, not an hour after the first. */
  const replacementRetired = rig(122);
  await runSeatTickCheck(fixture.project, replacementRetired.deps);
  expect(fixture.row().retiredWakes).toMatchObject([{ reason: "unresolved-age" }, { reason: "unresolved-age" }]);
  expect(replacementRetired.sent).toHaveLength(1);
  expect(replacementRetired.sent[0]!.clientMessageId).not.toBe(replacement.clientMessageId);
});

/* The one answer the bound must not act on. A holder that affirms it still HAS
   the payload is going to deliver it, so retiring the attempt would turn a wake
   still on its way into a guaranteed duplicate. The attempt is kept past its
   bound, no second wake is prepared beside it — and the deferral says which key
   kept it, instead of quoting a lapse that has been and gone. */
test("an attempt its holder still accounts for is kept past its bound, and no second wake is prepared beside it (#1746)", async () => {
  const outstanding = outstandingWake({ preparedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString() });
  const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "retained" });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(rig.sent).toEqual([]);
  expect(rig.written.at(-1)!.outstandingWake).toEqual(outstanding);
  expect(rig.written.at(-1)!.retiredWakes).toEqual([]);
  expect(record!.detail).toContain(`under key ${outstanding.clientMessageId}`);
  expect(record!.detail).toContain("age bound was spent at");
  expect(record!.detail).toContain("the next check retires it unresolved and may wake this project");
  expect(record!.detail).toContain("unless the layer holding it reports by then that it still has the payload");
  expect(record!.detail).not.toContain("the fence lapses at");
});

/* The same restraint for a transport call that has not come back: retiring an
   attempt mid-flight is how two wakes reach one seat. */
test("an attempt whose transport call is still out is kept past its bound (#1746)", async () => {
  const outstanding = outstandingWake({ preparedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString(), dispatch: { token: "dispatch-token", state: "active" } });
  const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "uncertain" });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(rig.written.at(-1)!.retiredWakes).toEqual([]);
  expect(rig.written.at(-1)!.outstandingWake).toMatchObject({ clientMessageId: outstanding.clientMessageId, dispatch: { state: "active" } });
  expect(record).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
});

/* Retirement on age leaves the payload addressed to the seat that still holds
   the project, which is the one case where a duplicate can still be prevented
   outright: the holder is asked for it back, under a reason that says which
   retirement this was. */
test("a wake retired on its age is taken back out of the queue that still holds it, for a reason that names the bound (#1746)", async () => {
  const aged = {
    wake: outstandingWake({ seatEpoch: 7, operationId: null, text: "the wake nobody could account for",
      preparedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString(), dispatch: { token: "dispatch-token", state: "refused" as const } }),
    retiredAt: new Date(NOW - 60 * MINUTE).toISOString(),
    supersededBy: null,
    reason: "unresolved-age" as const,
  };
  const taken = harness({ pipelines: OPEN_LANE, state: { ...RECENT, seatEpoch: 7, retiredWakes: [aged] }, wakeState: "retained", withdrawal: "withdrawn" });
  await runSeatTickCheck(PROJECT, taken.deps);
  expect(taken.withdrawn.map((call) => call.wake.clientMessageId)).toEqual([aged.wake.clientMessageId]);
  expect(taken.withdrawn[0]!.reason).toContain("retired unresolved after its age bound");
  expect(taken.withdrawn[0]!.reason).not.toContain("has since been replaced");
  const revocation = taken.journal.find((line) => line.verdict === "revoked")!;
  expect(revocation).toMatchObject({ delivery: { clientMessageId: aged.wake.clientMessageId, outcome: "withdrawn" } });
  expect(revocation.detail).toContain("retired unresolved on its age bound was taken out of the queue holding it");
  expect(taken.written.at(-1)!.retiredWakes).toEqual([]);
  /* And it is never sent again under its own key, whatever the holder answered. */
  expect(taken.sent.map((message) => message.clientMessageId)).not.toContain(aged.wake.clientMessageId);

  /* A holder that cannot give it back keeps it where it is, and the board — not
     a journal line per check — is what carries the wait. */
  const late = harness({ pipelines: OPEN_LANE, state: { ...RECENT, seatEpoch: 7, retiredWakes: [aged] }, wakeState: "retained", withdrawal: "too-late" });
  await runSeatTickCheck(PROJECT, late.deps);
  expect(late.written.at(-1)!.retiredWakes).toEqual([aged]);
  expect(late.cards.map((raised) => raised.card.instance)).toEqual([aged.wake.clientMessageId]);
  expect(late.cards[0]!.card.detail).toContain("retired unresolved on its age bound");
  expect(late.sent.map((message) => message.clientMessageId)).not.toContain(aged.wake.clientMessageId);
});

test("the wake replacing an attempt retired on its age stays inside the bound the runtime journal admits, and reaches the seat (#1771)", async () => {
  const { fixture, child, wake, rig } = await strandedManagerWake("mute-seat-key-bound", {
    seatEpoch: 173, wakeIntervalMinutes: 20, monitorPrompt: MUTE_PROMPT,
  });
  /* The original attempt is the readable composition, prompt digest and all,
     and it fits — which is why the seat got that first wake and no other. */
  expect(wake.clientMessageId).toContain(":prompt-");
  expect(wake.clientMessageId.length).toBeLessThanOrEqual(RUNTIME_IDEMPOTENCY_KEY_LIMIT);

  /* The bound spent. The replacement folds the whole composition — the
     retired key's digest included — behind the project and the seat epoch,
     because the readable form of it no longer fits. */
  const past = rig(61);
  const woken = await runSeatTickCheck(fixture.project, past.deps);
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(past.sent).toHaveLength(1);
  const replacement = past.sent[0]!.clientMessageId!;
  expect(replacement).not.toBe(wake.clientMessageId);
  expect(replacement.startsWith(`seat-tick:${fixture.project}:173:digest-`)).toBe(true);
  expect(replacement.length).toBeLessThanOrEqual(RUNTIME_IDEMPOTENCY_KEY_LIMIT);
  /* It landed, so the stamp the whole loop turned on finally moves, and the
     retired attempt is the only thing left fenced — crediting nothing. */
  expect(fixture.row()).toMatchObject({ outstandingWake: null, lastWakeAt: new Date(fixture.now + 61 * MINUTE).toISOString() });
  expect(fixture.row().retiredWakes).toMatchObject([{ wake: { clientMessageId: wake.clientMessageId }, reason: "unresolved-age" }]);
  /* And the wake carried the obligations the retired attempt named. */
  expect(past.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(past.sent[0]!.text).toContain(MUTE_PROMPT);
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* The verdict that matters is the production validator's, not a number this
     test picked: the real journal admits the replacement key, and refuses one
     character past the bound. */
  const journal = new RuntimeJournal(path.join(fixture.dir, "key-admission.sqlite"), { structuredHosts: true });
  try {
    const admitted = journal.executeOperation(admissionCommand(wake.conversationId, replacement, past.sent[0]!.text));
    expect(admitted.receipt).toMatchObject({ idempotencyKey: replacement });
    expect(() => journal.executeOperation(admissionCommand(wake.conversationId, "k".repeat(RUNTIME_IDEMPOTENCY_KEY_LIMIT + 1), "over the bound")))
      .toThrow("idempotencyKey is invalid");
  } finally {
    journal.close();
  }
});

test("a wake whose identity crosses the bound is admitted by the real journal through the real transport, and lands (#1771)", async () => {
  const fixture = childFixture("mute-seat-real-transport");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  /* The marker an age-bound retirement leaves behind, which is what pushed the
     live project's next key past the bound. */
  fixture.seed({ releasedWake: { clientMessageId: `seat-tick:${fixture.project}:173:retired`, releasedAt: ago(fixture, 5) } });
  const { journal, client } = hostedSeat(fixture);
  try {
    const settings = { ...defaultSeatTickSettings(fixture.project), wakeIntervalMinutes: 20, reason: "this project batches its wakes", monitorPrompt: MUTE_PROMPT };
    const rig = childRig(fixture, { realWakeState: true, journal: { client }, settings, settlementNow: () => Date.now(), deliverWith: realTransport(fixture, client) });
    const record = await runSeatTickCheck(fixture.project, rig.deps);
    /* Queued by the real journal, under a key it admitted. Before the bound
       existed this check ended `failed`: the journal threw at admission, the
       claimed reservation was left delivery-uncertain, and the seat was fenced
       behind it for the hour. */
    expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "queued" } });
    const outstanding = fixture.row().outstandingWake!;
    expect(outstanding.clientMessageId.length).toBeLessThanOrEqual(RUNTIME_IDEMPOTENCY_KEY_LIMIT);
    expect(journal.operationResult(outstanding.operationId!)?.receipt).toMatchObject({ status: "queued", idempotencyKey: outstanding.clientMessageId });
    expect(journal.effectBatch(100, ["runtime.send"]).map((effect) => effect.payload.operationId)).toEqual([outstanding.operationId]);

    /* The drain delivers it and the next check credits the plan: the stamp
       moves, the child is harvested, and the released marker is cleared. */
    journal.transitionOperation(outstanding.operationId!, "delivered");
    const landed = childRig(fixture, { realWakeState: true, journal: { client }, settings, now: fixture.now + 5 * MINUTE, settlementNow: () => Date.now(), deliverWith: realTransport(fixture, client) });
    expect(await runSeatTickCheck(fixture.project, landed.deps)).toMatchObject({ verdict: "quiet" });
    expect(landed.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: outstanding.clientMessageId, outcome: "landed" } });
    expect(fixture.row()).toMatchObject({ outstandingWake: null, releasedWake: null, lastWakeAt: new Date(fixture.now + 5 * MINUTE).toISOString() });
    expect(fixture.acknowledged()).toEqual([child.id]);
  } finally {
    journal.close();
  }
});

/* Outcome 2 of the issue: "prepared, with nothing delivered and nothing
   recorded" is the state to eliminate. A layer that refuses a send answers with
   a reason, and the check's own journal line — which the seat surface reads
   back as the last run's detail — is where it belongs. */
test("a wake the delivery layer would not take names the refusal on the check's journal line (#1771)", async () => {
  const fixture = childFixture("mute-seat-refusal-named");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const refused = childRig(fixture, {
    deliverWith: async () => ({ ok: false, outcome: "failed", error: "clientMessageId is longer than the 200 characters the runtime journal admits, so no send was reserved", status: 400 }),
  });
  const record = await runSeatTickCheck(fixture.project, refused.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "failed" } });
  expect(record!.detail).toContain("the delivery layer would not take the wake");
  expect(record!.detail).toContain("the runtime journal admits");

  /* A transport call that never came back says that instead, on its own
     project: the prepared attempt is kept either way, and the line is what
     tells an operator which of the two happened. */
  const other = childFixture("mute-seat-transport-threw");
  setAgentRegistryForTests(other.registry);
  other.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(other, 20) });
  other.seed();
  const threw = childRig(other, { deliveryThrows: true });
  const unreturned = await runSeatTickCheck(other.project, threw.deps);
  expect(unreturned).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(unreturned!.detail).toContain("the transport call for the wake did not return");
  expect(other.row().outstandingWake).not.toBeNull();
});

test("a completed lane the seat launched leads the wake, and stale children are counted rather than listed (#1749)", async () => {
  const fixture = childFixture("own-lane-over-stale-children");
  /* Forty children that finished a fortnight before this seat was designated,
     which is what filled every wake in the evidence. */
  const historical = Array.from({ length: 40 }, (_, n) => fixture.spawn({
    title: `historical worker ${n}`,
    turn: "terminal",
    terminalAt: ago(fixture, 20 * 24 * 60),
  }));
  fixture.seed();
  const rig = childRig(fixture, {
    seat: { ...fixture.seat, designatedAt: ago(fixture, 120) },
    pipelines: [ownLane(fixture)],
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"] });
  expect(rig.sent).toHaveLength(1);
  const text = rig.sent[0]!.text;

  /* First: the line straight under the agenda's heading, which is where the
     five-item bound cuts from. */
  const agenda = text.split("\nItems:\n")[1]!.split("\n").filter((line) => line.startsWith("- "));
  expect(agenda[0]).toContain("pipeline_own_lane");
  expect(record).toMatchObject({ items: 1 });

  /* And not one of the forty is named: they are a number on one line. */
  for (const child of historical) expect(text).not.toContain(child.id);
  const summarised = text.match(/\((\d+) spawned child\(ren\) not listed/);
  expect(summarised).not.toBeNull();
  expect(Number(summarised![1])).toBeGreaterThan(0);
  expect(fixture.acknowledged()).toEqual([]);
}, 60_000);

test("an outcome harvested under an earlier seat epoch is not listed again after a rotation (#1749)", async () => {
  const fixture = childFixture("harvested-before-rotation");
  const child = fixture.spawn({ title: "worker", turn: "terminal", terminalAt: ago(fixture, 240) });
  fixture.seed();
  /* Epoch 7 takes the outcome: a wake that lands is what acknowledges it. */
  const first = childRig(fixture, { seat: { ...fixture.seat, designatedAt: ago(fixture, 600) } });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"] });
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* The re-mint: a second turn read out of the same ledger is a NEW outcome
     identity for a conversation whose result was consumed under epoch 7, and
     its terminal instant is still the one the registry recorded then. Before
     this, the rotation's first wake carried it back to the successor. */
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "completed", seq: 4 });

  const rotated = childRig(fixture, {
    now: fixture.now + 61 * MINUTE,
    seat: { ...fixture.seat, seatEpoch: 8, designatedAt: ago(fixture, 120) },
  });
  const record = await runSeatTickCheck(fixture.project, rotated.deps);
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(rotated.sent).toEqual([]);
});

test("the wake a settled own lane raises composes a key the runtime journal admits (#1749)", async () => {
  const fixture = childFixture("own-lane-key-bound");
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 10) });
  /* Everything that has ever lengthened this key at once: the marker an
     age-bound retirement leaves, a monitor prompt's digest, and now a second
     reason kind beside the child's. */
  fixture.seed({ releasedWake: { clientMessageId: `seat-tick:${fixture.project}:7:retired`, releasedAt: ago(fixture, 5) } });
  const rig = childRig(fixture, {
    seat: { ...fixture.seat, designatedAt: ago(fixture, 600) },
    settings: { ...defaultSeatTickSettings(fixture.project), monitorPrompt: MUTE_PROMPT },
    pipelines: [ownLane(fixture, { state: "needs_decision", attemptState: "needs_decision" })],
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled", "child-terminal"] });
  const key = rig.sent[0]!.clientMessageId!;
  expect(key.length).toBeLessThanOrEqual(RUNTIME_IDEMPOTENCY_KEY_LIMIT);

  /* The verdict that counts is the production validator's, and the same
     journal refuses one character past the bound. */
  const journal = new RuntimeJournal(path.join(fixture.dir, "own-lane-key-admission.sqlite"), { structuredHosts: true });
  try {
    expect(journal.executeOperation(admissionCommand(child.id, key, rig.sent[0]!.text)).receipt).toMatchObject({ idempotencyKey: key });
    expect(() => journal.executeOperation(admissionCommand(child.id, "k".repeat(RUNTIME_IDEMPOTENCY_KEY_LIMIT + 1), "over the bound")))
      .toThrow("idempotencyKey is invalid");
  } finally {
    journal.close();
  }
});

test("a child whose record is weeks old is skipped though a sweep refreshed its registry row (#1783)", async () => {
  const fixture = childFixture("swept-stale-child");
  const child = fixture.spawn({ title: "historical worker", turn: "terminal", terminalAt: null });
  ageTranscript(fixture, child.path, 20 * 24 * 60);
  sweepRegistryRow(fixture, child, "historical worker");
  fixture.seed();

  /* The condition under test, on the row itself: nothing says when this child
     ended except its transcript, and what the registry does say is younger
     than the seat. An age test reading the registry lists it. */
  const conversation = fixture.registry.conversation(child.id as never)!;
  expect(conversation.turn.terminalAt).toBeNull();
  expect(Date.parse(conversation.turn.observedAt!)).toBeGreaterThan(Date.parse(ago(fixture, 120)));

  const rig = childRig(fixture, {
    seat: { ...fixture.seat, designatedAt: ago(fixture, 120) },
    pipelines: [ownLane(fixture)],
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"], items: 1 });
  const text = rig.sent[0]!.text;
  expect(text).not.toContain(child.id);
  expect(text).toContain("(1 spawned child(ren) not listed: their last activity predates this seat's designation");
  expect(fixture.acknowledged()).toEqual([]);
});
