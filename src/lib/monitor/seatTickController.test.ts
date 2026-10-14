// Reconciliation and deploy settlement retain the original path so existing
// main-side failures keep their test identities after the suite split.
import { describe, expect, spyOn, test, fs, path, spawn, SANDBOX, SESSIONS, runSeatTickCheck, SEAT_TICK_WAKE_UNRESOLVED_REF, startSeatTick, stopSeatTick, writeDrain, drainFile, releaseDrain, DEFAULT_SEAT_TICK_POLICY, defaultSeatTickSettings, settleRecordFromJournal, readSeatTickState, writeSeatTickState, SeatTickAccounting, FileRuntimeEventStore, statePath, AgentRegistry, setAgentRegistryForTests, emptyLaunchProfile, emptySeatTickState, PROJECT, CONVERSATION, SUCCESSOR, NOW, MINUTE, pipelineRecord, harness, OVERDUE, RECENT, outstandingWake, OPEN_LANE, HELD, childFixture, childRig, ago, ownLane, ageTranscript, sweepRegistryRow, agendaOf, endedTurnUnderADeadHost, STANDING_BOARD, unresolvedCardsOn, standingProject, MIGRATION_REFUSAL, REPORT_SHA, reportDeploys, settledLane, reportPort } from "./seatTickController.fixture";
import type { SeatTickControllerDependencies, SeatTickProjectState, AgentLivenessRecord, ConversationMessage, DeliveryOutcome } from "./seatTickController.fixture";


test("one child with a failed and a finished turn is one line carrying its latest state (#1783)", async () => {
  const fixture = childFixture("one-line-per-child");
  const child = fixture.spawn({ title: "iterative worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  /* A second ended turn out of the same ledger: a second owed outcome for one
     child, which is how the same child reached one wake five times. */
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "error", seq: 4 });
  fixture.seed();

  const rig = childRig(fixture, { seat: { ...fixture.seat, designatedAt: ago(fixture, 600) } });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1, deferred: 0 });
  const text = rig.sent[0]!.text;
  /* One line, and the failure is the one it carries: the wake describes the
     child by its latest state, not once per owed row. */
  expect(text.split(child.id)).toHaveLength(2);
  expect(text).toContain(`${child.id} — iterative worker — spawned child failed, outcome announcement owed`);

  /* The line stood for both rows, so the landing acknowledged both. */
  const outcomes = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project).collection.snapshot()
    .filter((row) => row.kind === "outcome");
  expect(outcomes).toHaveLength(2);
  expect(outcomes.every((row) => row.status === "acknowledged")).toBe(true);
});

test("a finished child whose transcript the Viewer cannot resolve is listed with why, and harvested once (#1783, #1881)", async () => {
  const fixture = childFixture("unresolvable-transcript");
  const unscanned = fixture.spawn({ title: "worker outside the roots", turn: "terminal", terminalAt: ago(fixture, 20), transcript: "outside-roots" });
  const gone = fixture.spawn({ title: "worker whose transcript is gone", turn: "terminal", terminalAt: ago(fixture, 20), transcript: "missing" });
  fixture.seed();

  const rig = childRig(fixture, {
    seat: { ...fixture.seat, designatedAt: ago(fixture, 600) },
    pipelines: [ownLane(fixture)],
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  /* The registry's turn state says both finished, and that is the seat's to
     know whether or not a word of either can be read (#1881). */
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled", "child-terminal"], items: 3 });
  const text = rig.sent[0]!.text;
  expect(text).toContain(`${unscanned.id} — worker outside the roots — spawned child finished, transcript not readable: its transcript path is outside every folder Delegatus scans`);
  expect(text).toContain(`${gone.id} — worker whose transcript is gone — spawned child finished, transcript not readable: the transcript file is no longer on disk`);
  expect(text).not.toContain("cannot resolve their transcript");
  expect(fixture.acknowledged().sort()).toEqual([unscanned.id, gone.id].sort());
});

test("a child a delivered wake showed is not shown again until it ends another turn (#1783)", async () => {
  const fixture = childFixture("shown-once-per-state");
  const child = fixture.spawn({ title: "worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "completed", seq: 4 });
  fixture.seed();

  const shown = childRig(fixture, { seat: { ...fixture.seat, designatedAt: ago(fixture, 600) } });
  expect(await runSeatTickCheck(fixture.project, shown.deps)).toMatchObject({ verdict: "wake", items: 1 });
  expect(fixture.acknowledged()).toEqual([child.id, child.id]);

  /* An hour later, with the child in exactly the state the seat was shown. */
  const unchanged = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat: { ...fixture.seat, designatedAt: ago(fixture, 600) } });
  expect(await runSeatTickCheck(fixture.project, unchanged.deps)).toMatchObject({ verdict: "quiet" });
  expect(unchanged.sent).toEqual([]);

  /* Its state changes: it ends another turn, and that IS owed. */
  ledger.append(generation, { kind: "turn-started", turnId: "turn-three", seq: 5 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-three", status: "error", seq: 6 });
  const moved = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat: { ...fixture.seat, designatedAt: ago(fixture, 600) } });
  expect(await runSeatTickCheck(fixture.project, moved.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(moved.sent[0]!.text).toContain(`${child.id} — worker — spawned child failed, outcome announcement owed`);
});

test("a failure this seat's own worker just had is listed beside the history that is not (#1783)", async () => {
  const fixture = childFixture("new-failure-still-listed");
  const historical = fixture.spawn({ title: "historical worker", turn: "terminal", terminalAt: null });
  ageTranscript(fixture, historical.path, 20 * 24 * 60);
  sweepRegistryRow(fixture, historical, "historical worker");
  const recent = fixture.spawn({ title: "current worker", turn: "terminal", terminalAt: ago(fixture, 15) });
  const generation = fixture.registry.conversation(recent.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "error", seq: 4 });
  fixture.seed();

  const rig = childRig(fixture, { seat: { ...fixture.seat, designatedAt: ago(fixture, 120) } });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  const text = rig.sent[0]!.text;
  expect(text).toContain(`${recent.id} — current worker — spawned child failed, outcome announcement owed`);
  expect(text).not.toContain(historical.id);
  expect(text).toContain("(1 spawned child(ren) not listed: their last activity predates this seat's designation");
});

test("a child whose last record predates the seat by weeks is skipped on the harvest and on the stall path (#1783)", async () => {
  const fixture = childFixture("aged-child-both-paths");
  /* One of each, both in the August shape: an open turn on the registry, a
     dead host, and a transcript nothing has appended to for twenty-five days.
     The first also owes an outcome, which is what puts it on the harvest. */
  const owed = fixture.spawn({ title: "august worker", turn: "busy", host: "dead" });
  endedTurnUnderADeadHost(fixture, owed, "completed", 1);
  const stalled = fixture.spawn({ title: "august stall", turn: "busy", host: "dead" });
  for (const child of [owed, stalled]) ageTranscript(fixture, child.path, 25 * 24 * 60);
  fixture.seed();

  /* The condition under test, on the rows themselves: neither child has a
     terminal instant to test, and the seat was designated two hours ago. */
  for (const child of [owed, stalled]) {
    const conversation = fixture.registry.conversation(child.id as never)!;
    expect(conversation.turn.state).toBe("busy");
    expect(conversation.turn.terminalAt).toBeNull();
  }

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  const first = childRig(fixture, { seat, pipelines: [ownLane(fixture)] });
  await runSeatTickCheck(fixture.project, first.deps);
  /* The stall memory saw both of them, which is what makes the second check
     the one where the stall path WOULD name them. */
  expect(fixture.row().stalledSeen).toEqual([`child:${owed.id}`, `child:${stalled.id}`]);

  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat, pipelines: [ownLane(fixture)] });
  const record = await runSeatTickCheck(fixture.project, second.deps);
  /* The lane was already announced, and neither old child can raise another
     reason. */
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(second.sent).toEqual([]);
  expect(fixture.acknowledged()).toEqual([]);
});

test("an unreadable child is listed when it finished and named once when it stalled (#1783, #1881)", async () => {
  const fixture = childFixture("unresolvable-child-both-paths");
  /* Spawned an hour ago — nothing about either of these is old — and neither
     transcript is one this Viewer can read: one is outside every scanner root,
     the other has gone from disk. No seat can harvest or read either, however
     recently it ran. */
  const owed = fixture.spawn({ title: "unscanned worker", turn: "busy", host: "dead", transcript: "outside-roots" });
  endedTurnUnderADeadHost(fixture, owed, "error", 1);
  const stalled = fixture.spawn({ title: "vanished worker", turn: "busy", host: "dead", transcript: "missing" });
  fixture.seed();

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  const first = childRig(fixture, { seat, pipelines: [ownLane(fixture)] });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled", "child-terminal"] });
  expect(fixture.row().stalledSeen).toEqual([`child:${owed.id}`, `child:${stalled.id}`]);
  /* The ended turn is owed and listed with its reason (#1881). The open turn
     under a dead host is not work, and is named beside the agenda with why. */
  const shown = first.sent[0]!.text;
  expect(shown).toContain(`${owed.id} — unscanned worker — spawned child failed, transcript not readable: its transcript path is outside every folder Delegatus scans`);
  expect(shown).toContain(`- ${stalled.id} — vanished worker: the transcript file is no longer on disk`);
  expect(fixture.acknowledged()).toEqual([owed.id]);

  /* Named once: the next check neither lists nor names either of them. */
  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat, pipelines: [ownLane(fixture)] });
  const record = await runSeatTickCheck(fixture.project, second.deps);
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(second.sent).toEqual([]);
});

test("a failure this seat's own worker had an hour ago is listed, once (#1783)", async () => {
  const fixture = childFixture("new-failure-listed-once");
  /* The same shape as the children above, and a different answer: this one is
     this seat's and it is an hour old, not a month. */
  const child = fixture.spawn({ title: "current worker", turn: "busy", host: "dead" });
  fixture.seed();

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  /* The first check sees the stall; a stall is only reported once it has
     survived a second one, so this wake carries the open worker and no more. */
  const first = childRig(fixture, { seat });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(fixture.row().stalledSeen).toEqual([`child:${child.id}`]);

  /* Then its host writes an ended turn to the ledger and dies over the open
     turn — the production shape exactly. The check that follows holds the same
     child on BOTH paths: an outcome nobody has harvested, and a stall that has
     now persisted across two checks. */
  endedTurnUnderADeadHost(fixture, child, "error", 1);
  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat });
  const record = await runSeatTickCheck(fixture.project, second.deps);
  expect(record).toMatchObject({ verdict: "wake", items: 1 });
  expect(record!.reasons).toContain("child-terminal");
  expect(record!.reasons).toContain("stalled");
  const text = second.sent[0]!.text;
  /* One line on the agenda, and it is the one that says what to do: the
     failure is the seat's to harvest, and the stall is the same conversation.
     Both reasons are true and the wake says both; the item list names the
     child once, which is the half a seat works from. */
  const agenda = agendaOf(text);
  expect(agenda.filter((line) => line.includes(child.id))).toEqual([
    `- [child] ${child.id} — current worker — spawned child failed, outcome announcement owed`,
  ]);
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* And it wakes nobody again while nothing about it moves. The outcome the
     line stood for is acknowledged, so the harvest no longer offers it; the
     stall it was shown in is the stall it is still in, so the stall path does
     not raise it a second time. The child is still open work, so the interval
     agenda still says so — once, and without the stall line under it. */
  const third = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat });
  const after = await runSeatTickCheck(fixture.project, third.deps);
  expect(after).toMatchObject({ verdict: "wake", reasons: ["interval"], items: 1 });
  const later = agendaOf(third.sent[0]!.text);
  expect(later).toEqual([`- [child] ${child.id} — current worker — spawned child running`]);
});

test("a stall one seat was shown is shown again to the seat that succeeds it (#1783)", async () => {
  const fixture = childFixture("stall-shown-across-rotation");
  /* A stall and nothing else: an open turn on the registry with no host behind
     it, spawned minutes ago, no ended turn in its ledger. It owes no outcome,
     so there is nothing a landing could acknowledge for it and nothing that
     will ever change its own record again — a dead host over an open turn
     writes no more of them. That is the case the showings record exists for,
     and therefore the case a rotation must not swallow. */
  const child = fixture.spawn({ title: "stalled worker", turn: "busy", host: "dead" });
  fixture.seed();
  const stallLine = `- [child] ${child.id} — stalled worker — child ${child.id} runs a turn the registry reports gone (host_gone_turn_open)`;

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  const first = childRig(fixture, { seat });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(fixture.row().stalledSeen).toEqual([`child:${child.id}`]);

  /* Epoch 7 is told, and the landing records the state it was shown in. */
  const shown = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat });
  expect((await runSeatTickCheck(fixture.project, shown.deps))!.reasons).toContain("stalled");
  expect(agendaOf(shown.sent[0]!.text)).toEqual([stallLine]);
  expect(fixture.row().childrenShown).toHaveLength(1);

  /* Same seat, nothing moved: not told again. This is what the record buys and
     what makes the question below a real one. */
  const again = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat });
  expect((await runSeatTickCheck(fixture.project, again.deps))!.reasons).not.toContain("stalled");
  expect(agendaOf(again.sent[0]!.text)).toEqual([`- [child] ${child.id} — stalled worker — spawned child running`]);

  /* The rotation. Epoch 8 was designated an hour ago, so the child's own clock
     is inside its day of grace and its transcript resolves: the first two
     clauses of the eligibility test pass for it. The third is the one at issue
     — a successor must not be answered with what its predecessor was shown,
     because for this child the token never changes again and the successor
     would then never be told at all. The showings are the seat's judgement and
     the row is projected per epoch, so the rotation drops them; the stall
     memory goes with them, which is why the successor's first check re-observes
     the stall and its second reports it, exactly as the first seat's did. */
  const successor = { ...fixture.seat, seatEpoch: 8, designatedAt: ago(fixture, 60) };
  const rotated = childRig(fixture, { now: fixture.now + 183 * MINUTE, seat: successor });
  await runSeatTickCheck(fixture.project, rotated.deps);
  expect(fixture.row().stalledSeen).toEqual([`child:${child.id}`]);

  const told = childRig(fixture, { now: fixture.now + 244 * MINUTE, seat: successor });
  const record = await runSeatTickCheck(fixture.project, told.deps);
  expect(record!.reasons).toContain("stalled");
  /* Once, and under the stall heading. */
  expect(agendaOf(told.sent[0]!.text).filter((line) => line.includes(child.id))).toEqual([stallLine]);
  /* And what the predecessor was shown is gone from the row rather than
     accumulated beside it: one token per child, whoever was shown it. */
  expect(fixture.row().childrenShown).toHaveLength(1);

  /* And the successor is told once, the same as its predecessor was: the
     record is per seat, not per wake. */
  const settled = childRig(fixture, { now: fixture.now + 305 * MINUTE, seat: successor });
  await runSeatTickCheck(fixture.project, settled.deps);
  expect(agendaOf(settled.sent[0]!.text).filter((line) => line.includes("reports gone"))).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * The third place the same list is read (#1783, round two review).
 *
 * The item list filters the running children; the two clauses that decide a
 * wake is WARRANTED at all did not. So a board whose only children are the
 * August workers and the unreadable one raised an interval wake every hour
 * that named nothing — the empty hourly agenda this whole mechanism exists to
 * stop sending, arriving under the reason that says work is open. One test
 * per side of that: a board of nothing but ineligible children ends quiet, and
 * a board with one eligible child beside them still wakes and names it.
 * ------------------------------------------------------------------------- */

test("a board whose only children are ineligible ends quiet rather than raising an interval wake (#1783)", async () => {
  const fixture = childFixture("ineligible-children-quiet");
  /* The production shape with the lane taken away: two workers whose hosts
     died over an open turn, one last written to twenty-five days before the
     designation and one whose transcript no scanner root holds. Nothing else
     on the board — no lane, no task, no signal. */
  const aged = fixture.spawn({ title: "august stall", turn: "busy", host: "dead" });
  ageTranscript(fixture, aged.path, 25 * 24 * 60);
  const unreadable = fixture.spawn({ title: "vanished stall", turn: "busy", host: "dead", transcript: "missing" });
  fixture.seed();

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  const first = childRig(fixture, { seat });
  /* The stall memory saw both, so the check below is the one on which the
     stall path would speak — and the one the interval clause spoke on. */
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "quiet" });
  expect(fixture.row().stalledSeen).toEqual([`child:${aged.id}`, `child:${unreadable.id}`]);
  expect(first.sent).toEqual([]);

  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat });
  const record = await runSeatTickCheck(fixture.project, second.deps);
  /* No wake at all. Neither child is work this seat can act on, so neither is
     open work, and an hour elapsing over them is not an agenda. */
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(second.sent).toEqual([]);
});

test("one eligible child beside the ineligible ones still raises the interval wake and is named (#1783)", async () => {
  const fixture = childFixture("eligible-child-still-wakes");
  /* The same two, and one worker this seat spawned minutes ago whose host is
     alive: the clause the fix narrows must still let this one through. */
  const aged = fixture.spawn({ title: "august stall", turn: "busy", host: "dead" });
  ageTranscript(fixture, aged.path, 25 * 24 * 60);
  const unreadable = fixture.spawn({ title: "vanished stall", turn: "busy", host: "dead", transcript: "missing" });
  const live = fixture.spawn({ title: "build the exporter", turn: "busy", host: "live" });
  fixture.seed();

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  const rig = childRig(fixture, {
    seat,
    childActivity: { [live.id]: { lifecycle: "running", reason: "host_alive_turn_active" } },
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"], items: 1 });
  const agenda = agendaOf(rig.sent[0]!.text);
  expect(agenda).toEqual([`- [child] ${live.id} — build the exporter — spawned child running`]);
  expect(agenda.join("\n")).not.toContain(aged.id);
  expect(agenda.join("\n")).not.toContain(unreadable.id);
});

/* ---------------------------------------------------------------------------
 * The seat's create call is answered before the base is resolved (#1799), so
 * the outcome reaches the creator here — on the wake the tick already sends.
 * ------------------------------------------------------------------------- */

test("a lane the seat created reaches it as provisioned, on the wake and once (#1799)", async () => {
  const provisioned = [{
    id: "pipeline_p1799",
    state: "running",
    createdAt: new Date(NOW - 10 * MINUTE).toISOString(),
    movedAt: new Date(NOW - 2 * MINUTE).toISOString(),
    attemptState: "running",
    src: CONVERSATION,
  }];
  const rig = harness({ pipelines: provisioned, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);

  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"] });
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).toContain("[provisioning] pipeline_p1799");
  expect(rig.sent[0]!.text).toContain("provisioned, first stage running");
  /* The landing is what records it, and the row the check wrote carries it. */
  expect(rig.written.at(-1)!.announcedLanes).toEqual(["pipeline_p1799:provisioned"]);

  /* An hour later, with the lane still running, nothing is owed on it: there
     was never an obligation, only something to know, and the seat knows it. */
  const later = harness({
    pipelines: provisioned,
    state: { ...rig.written.at(-1)!, ...OVERDUE },
  });
  const second = await runSeatTickCheck(PROJECT, later.deps);
  expect(second!.reasons ?? []).not.toContain("own-lane-settled");
  expect(later.sent.map((message) => message.text).join("\n")).not.toContain("[provisioning]");
});

test("a provisioned lane wakes its creator again when it completes with closedAt (#2081)", async () => {
  const lane = {
    id: "pipeline_finished_2081", state: "completed", src: CONVERSATION,
    createdAt: new Date(NOW - 90 * MINUTE).toISOString(), movedAt: new Date(NOW - 50 * MINUTE).toISOString(),
    closedAt: new Date(NOW - 49 * MINUTE).toISOString(),
  };
  const rig = harness({ pipelines: [lane], state: { ...OVERDUE, announcedLanes: [lane.id] } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"], items: 1 });
  expect(rig.sent[0]!.text).toContain("lane you launched: completed");
  expect(rig.written.at(-1)!.announcedLanes).toContain(`${lane.id}:completed`);

  const later = harness({ pipelines: [lane], now: NOW + 61 * MINUTE, state: rig.written.at(-1)! });
  const second = await runSeatTickCheck(PROJECT, later.deps);
  expect(second!.reasons ?? []).not.toContain("own-lane-settled");
});

test("each settled state of one lane is announced once after provisioning (#2081)", async () => {
  const id = "pipeline_states_2081";
  let state: Partial<SeatTickProjectState> = { ...OVERDUE, announcedLanes: [id] };
  for (const [index, lane] of [
    { state: "needs_review", attemptState: "passed" },
    { state: "needs_decision", attemptState: "needs_decision" },
    { state: "running", attemptState: "failed" },
  ].entries()) {
    const now = NOW + index * 122 * MINUTE;
    const pipeline = { id, ...lane, src: CONVERSATION, createdAt: new Date(NOW - 90 * MINUTE).toISOString(), movedAt: new Date(now - MINUTE).toISOString() };
    const rig = harness({ pipelines: [pipeline], now, state });
    const record = await runSeatTickCheck(PROJECT, rig.deps);
    expect(record).toMatchObject({ verdict: "wake" });
    expect(record!.reasons).toContain("own-lane-settled");
    state = rig.written.at(-1)!;
    const repeat = harness({ pipelines: [pipeline], now: now + 61 * MINUTE, state });
    const second = await runSeatTickCheck(PROJECT, repeat.deps);
    expect(second!.reasons ?? []).not.toContain("own-lane-settled");
  }
});

test("more than 64 delivered lane settlements stay announced until their lanes age out (#2081)", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "lane-announcements-")), "seat-tick.json");
  writeSeatTickState(PROJECT, {
    ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE,
    lastProposalAt: new Date(NOW).toISOString(), accounting: undefined,
  }, stateFile);
  const lanes = Array.from({ length: 65 }, (_, index) => ({
    id: `pipeline_announced_${index.toString().padStart(2, "0")}`,
    state: "completed", src: CONVERSATION,
    createdAt: new Date(NOW - 10 * MINUTE).toISOString(),
    movedAt: new Date(NOW - MINUTE).toISOString(),
    closedAt: new Date(NOW).toISOString(),
  }));
  for (let round = 0; round < 13; round += 1) {
    const rig = harness({ pipelines: lanes, stateFile, now: NOW + round * 60 * MINUTE });
    expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"], items: 5 });
  }
  const repeated = harness({ pipelines: lanes, stateFile, now: NOW + 13 * 60 * MINUTE });
  expect(await runSeatTickCheck(PROJECT, repeated.deps)).toMatchObject({ verdict: "quiet" });
  expect(repeated.sent).toEqual([]);
  expect(readSeatTickState(PROJECT, stateFile).announcedLanes).toHaveLength(65);

  const agedOut = harness({ pipelines: lanes.slice(1), stateFile, now: NOW + 14 * 60 * MINUTE });
  expect(await runSeatTickCheck(PROJECT, agedOut.deps)).toMatchObject({ verdict: "quiet" });
  expect(readSeatTickState(PROJECT, stateFile).announcedLanes).toHaveLength(64);
  expect(readSeatTickState(PROJECT, stateFile).announcedLanes).not.toContain(`${lanes[0]!.id}:completed`);

  const expired = harness({ pipelines: lanes.slice(1), stateFile, now: NOW + 73 * 60 * MINUTE });
  await runSeatTickCheck(PROJECT, expired.deps);
  expect(readSeatTickState(PROJECT, stateFile).announcedLanes).toEqual([]);
});

test("a lane that never ran a stage tells its creator the provisioning failed, and why (#1799)", async () => {
  const parked = [{
    id: "pipeline_p1799",
    state: "needs_decision",
    createdAt: new Date(NOW - 10 * MINUTE).toISOString(),
    movedAt: null,
    stateDetail: "fetching origin/main: git fetch timed out after 60s",
    src: CONVERSATION,
  }];
  const rig = harness({ pipelines: parked, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);

  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"] });
  expect(rig.sent[0]!.text).toContain("provisioning failed, it never ran a stage: fetching origin/main: git fetch timed out after 60s");
  expect(rig.written.at(-1)!.announcedLanes).toEqual(["pipeline_p1799:provisioning-failed"]);
});

test("two unresolved attempts of one project share one standing card, updated in place", async () => {
  const { project, check } = standingProject("standing-card");
  const kept = { wakeState: "unknown" as const,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-standing", receipt: {} as never, structured: true } as DeliveryOutcome };

  const first = await check(NOW, kept);
  expect(first.rig.sent).toHaveLength(1);
  const firstKey = first.rig.sent[0]!.clientMessageId!;
  /* Past the interval: the first attempt is carded. */
  await check(NOW + 61 * MINUTE, kept);
  expect(await unresolvedCardsOn(project)).toHaveLength(1);
  /* Past the age bound: it retires, and a second attempt goes out. */
  const third = await check(NOW + 121 * MINUTE, kept);
  expect(third.rig.sent).toHaveLength(1);
  const secondKey = third.rig.sent[0]!.clientMessageId!;
  expect(secondKey).not.toBe(firstKey);
  /* Past the second attempt's interval: it is unresolved too. */
  await check(NOW + 182 * MINUTE, kept);

  const cards = await unresolvedCardsOn(project);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.text).toContain(secondKey);
  expect(cards[0]!.text).toContain("Attempts on this card: 2");

  /* A check that changes nothing leaves it exactly as it stands. */
  await check(NOW + 187 * MINUTE, kept);
  expect(await unresolvedCardsOn(project)).toEqual(cards);
});

test("a permanent refusal of the re-dispatch releases the attempt at once instead of fencing for the age bound", async () => {
  const { project, check } = standingProject("permanent-refusal");
  const refusing = { wakeState: "absent" as const, delivery: MIGRATION_REFUSAL };

  const first = await check(NOW, refusing);
  expect(first.rig.sent).toHaveLength(1);
  const firstKey = first.rig.sent[0]!.clientMessageId!;
  expect(first.row.outstandingWake?.clientMessageId).toBe(firstKey);

  /* Five minutes later, well inside the two-hour bound. */
  const second = await check(NOW + 5 * MINUTE, refusing);
  const released = second.rig.journal.find((line) => line.delivery?.clientMessageId === firstKey && line.delivery.outcome === "refused");
  expect(released).toBeDefined();
  expect(released!.detail).toContain("conversation migration prevents resume succession");
  /* The fence lifted: this check's own wake was not deferred behind the old one. */
  expect(second.record.delivery?.outcome).not.toBe("deferred-outstanding");
  expect(second.row.outstandingWake?.clientMessageId).not.toBe(firstKey);
  expect(second.row.releasedWake?.clientMessageId).toBe(firstKey);

  const cards = await unresolvedCardsOn(project);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.text).toContain("rotate the seat");
});

test("three consecutive permanent refusals open the circuit: the fourth check prepares no wake", async () => {
  const { project, check } = standingProject("refusal-circuit");
  const refusing = { wakeState: "absent" as const, delivery: MIGRATION_REFUSAL };
  let sent = 0;
  for (let index = 0; index < 3; index++) sent += (await check(NOW + index * 5 * MINUTE, refusing)).rig.sent.length;
  expect(sent).toBe(5);

  const fourth = await check(NOW + 15 * MINUTE, refusing);
  /* The third attempt's re-dispatch, and nothing new. */
  expect(fourth.rig.sent).toHaveLength(1);
  expect(fourth.row.outstandingWake).toBeNull();
  expect(fourth.record.delivery?.outcome).toBe("refusal-circuit");
  expect(fourth.record.detail).toContain("3 consecutive attempts");
  const cards = await unresolvedCardsOn(project);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.text).toContain("Attempts on this card: 3");
  expect(cards[0]!.text).toContain("prepares no new wake");

  /* Held: the next check sends nothing and rewrites nothing. */
  const fifth = await check(NOW + 20 * MINUTE, refusing);
  expect(fifth.rig.sent).toHaveLength(0);
  expect(fifth.record.delivery?.outcome).toBe("refusal-circuit");
  expect(await unresolvedCardsOn(project)).toEqual(cards);

  /* An operator's settings write for the project resets it, without the tick
     having touched the settings or the seat. */
  const written = { ...defaultSeatTickSettings(project), updatedAt: new Date(NOW + 21 * MINUTE).toISOString(), setBy: { kind: "operator" } as never };
  const reset = await check(NOW + 25 * MINUTE, { ...refusing, settings: written });
  expect(reset.rig.sent).toHaveLength(1);
  expect(reset.row.outstandingWake).not.toBeNull();
});

test("a seat rotation resets the refusal circuit", async () => {
  const { project, check } = standingProject("refusal-rotation");
  const refusing = { wakeState: "absent" as const, delivery: MIGRATION_REFUSAL };
  for (let index = 0; index < 4; index++) await check(NOW + index * 5 * MINUTE, refusing);
  expect((await check(NOW + 20 * MINUTE, refusing)).rig.sent).toHaveLength(0);
  expect(await unresolvedCardsOn(project)).toHaveLength(1);
  /* The successor takes wakes: the run ends, and so does the card that told
     the operator to rotate the seat. */
  const rotated = await check(NOW + 25 * MINUTE, { seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null } });
  expect(rotated.rig.sent.map((message) => message.conversationId)).toContain(SUCCESSOR);
  expect(await unresolvedCardsOn(project)).toEqual([]);
});

test("a rotation onto a seat that is still refusing closes the stale circuit card too", async () => {
  const { project, check } = standingProject("refusal-rotation-refusing");
  const refusing = { wakeState: "absent" as const, delivery: MIGRATION_REFUSAL };
  for (let index = 0; index < 4; index++) await check(NOW + index * 5 * MINUTE, refusing);
  expect(await unresolvedCardsOn(project)).toHaveLength(1);
  const rotated = await check(NOW + 20 * MINUTE, { ...refusing, seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null } });
  expect(rotated.rig.sent).toHaveLength(1);
  expect(await unresolvedCardsOn(project)).toEqual([]);
});

test("a project that never had an unresolved wake asks nothing of the board", async () => {
  const project = `no-card-${crypto.randomUUID().slice(0, 8)}`;
  const rig = harness({ pipelines: [{ ...OPEN_LANE[0]!, project }], settings: defaultSeatTickSettings(project), state: OVERDUE });
  await runSeatTickCheck(project, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(rig.cards.filter(({ card }) => card.kind === "wake-unresolved")).toEqual([]);
});

test("the standing card closes the per-attempt cards the earlier scheme left on the board", async () => {
  const { project, check } = standingProject("attempt-cards");
  const { mutateTasksFile, loadTasks } = await import("@/lib/tasks/store");
  const { createTask } = await import("@/lib/tasks/commands");
  mutateTasksFile((state) => {
    let tasks = state.tasks;
    let recentCreates = state.recentCreates;
    for (const hash of ["0123456789abcdef", "fedcba9876543210"]) {
      const created = createTask(tasks, { project, text: `Seat tick wake unresolved under its original key\n\nmonitor-ref: ${SEAT_TICK_WAKE_UNRESOLVED_REF}-${hash}`, placement: "unplaced" }, recentCreates);
      if (!created.ok) throw new Error("fixture card refused");
      tasks = created.tasks;
      recentCreates = created.recentCreates;
    }
    return { state: { ...state, tasks, recentCreates }, result: undefined };
  }, STANDING_BOARD());

  const refusing = { wakeState: "absent" as const, delivery: MIGRATION_REFUSAL };
  await check(NOW, refusing);
  await check(NOW + 5 * MINUTE, refusing);
  const open = loadTasks(STANDING_BOARD()).filter((task) => task.project === project && task.status !== "done");
  expect(open).toHaveLength(1);
  expect(open[0]!.text).toContain(`monitor-ref: ${SEAT_TICK_WAKE_UNRESOLVED_REF}\n`.trimEnd());
  expect(open[0]!.text).not.toContain(`${SEAT_TICK_WAKE_UNRESOLVED_REF}-`);
});

test("an attempt fencing the project outranks a standing refusal run on the card (#1594)", async () => {
  const { project, check } = standingProject("fence-over-run");
  let firstKey: string | null = null;
  /* The first attempt meets the permanent refusal; the next one is taken and
     kept by a layer that never settles it. */
  const deliverWith = async (message: ConversationMessage): Promise<DeliveryOutcome> => {
    firstKey ??= message.clientMessageId!;
    return message.clientMessageId === firstKey
      ? MIGRATION_REFUSAL
      : { ok: true, target: null, outcome: "queued", operationId: "op-fence", receipt: {} as never, structured: true };
  };
  await check(NOW, { wakeState: "absent", deliverWith });
  const second = await check(NOW + 5 * MINUTE, { wakeState: "absent", deliverWith });
  const fencingKey = second.row.outstandingWake!.clientMessageId;
  expect(fencingKey).not.toBe(firstKey);
  expect(second.row.refusals?.count).toBe(1);

  await check(NOW + 70 * MINUTE, { wakeState: "absent", deliverWith });
  const cards = await unresolvedCardsOn(project);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.text).toContain(`newest key: ${fencingKey}`);
  expect(cards[0]!.text).toContain("dispatches no replacement wake");
  /* And the refusal still asks for the operator. */
  expect(cards[0]!.text).toContain("rotate the seat");
});

/* ---------------------------------------------------------------------------
 * A seat that deploys pauses its lanes, calls deploy_exact_sha and ends its
 * turn, because the promotion replaces its host (#2063). The deploy settling is
 * the wake it is waiting for, and the lanes it paused are that wake's work.
 * ------------------------------------------------------------------------- */

test("a deploy the seat started wakes it once when it settles, with the lanes it paused (#2063)", async () => {
  const paused = (id: string, detail: string) => ({
    id, state: "paused", createdAt: new Date(NOW - 120 * MINUTE).toISOString(), movedAt: new Date(NOW - 20 * MINUTE).toISOString(), stateDetail: detail,
  });
  const pipelines = [
    paused("pipeline_s1", `paused by worker ${CONVERSATION}`),
    paused("pipeline_s2", `paused by orchestrator ${CONVERSATION}`),
    paused("pipeline_s3", `paused by worker ${CONVERSATION}`),
    paused("pipeline_op", "paused by operator"),
  ];
  const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
  const deploys = {
    seatDeployments: [
      { deploymentId: "deploy-own", conversationId: CONVERSATION },
      { deploymentId: "deploy-own-running", conversationId: CONVERSATION },
      { deploymentId: "deploy-foreign", conversationId: SUCCESSOR },
    ],
    deployments: {
      "deploy-own": { phase: "succeeded", terminal: true, revision: SHA },
      "deploy-own-running": { phase: "promoting", terminal: false, revision: SHA },
      "deploy-foreign": { phase: "failed", terminal: true, revision: SHA, error: "candidate health failed" },
    },
  };
  /* The wake before the deploy landed six minutes ago. The hour it would
     otherwise wait out is what kept the seat idle for thirty minutes. */
  const rig = harness({ pipelines, ...deploys, state: { lastWakeAt: new Date(NOW - 6 * MINUTE).toISOString() } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);

  expect(record).toMatchObject({ verdict: "wake" });
  expect(record!.reasons).toContain("deploy-settled");
  expect(rig.sent).toHaveLength(1);
  const text = rig.sent[0]!.text;
  expect(text).toContain(`- [deploy] deploy-own — deploy settled: the deployment you started succeeded, sha ${SHA}`);
  for (const id of ["pipeline_s1", "pipeline_s2", "pipeline_s3"]) {
    expect(text).toContain(`- [pipeline] ${id} — lane ${id} — paused by you; resume it`);
  }
  /* Not the seat's: a deploy another seat started, a deploy still running and
     a lane the operator paused. */
  expect(text).not.toContain("deploy-foreign");
  expect(text).not.toContain("deploy-own-running");
  expect(text).not.toContain("pipeline_op");
  expect(rig.written.at(-1)!.announcedDeploys).toEqual(["deploy-own"]);

  /* Ten minutes later nothing new has settled: the landed wake announced the
     deploy, so it wakes nobody a second time. */
  const again = harness({ pipelines, ...deploys, now: NOW + 10 * MINUTE, state: rig.written.at(-1)! });
  const second = await runSeatTickCheck(PROJECT, again.deps);
  expect(second!.reasons ?? []).not.toContain("deploy-settled");
  expect(again.sent).toHaveLength(0);

  /* A later stall wake can name the still-parked lanes. The settled deploy
     has already been announced and must not be announced again. */
  const hourly = harness({ pipelines, ...deploys, now: NOW + 70 * MINUTE, state: again.written.at(-1)! });
  const third = await runSeatTickCheck(PROJECT, hourly.deps);
  expect(third!.reasons ?? []).not.toContain("deploy-settled");
  expect(hourly.sent.every(message => !message.text.includes("[deploy] deploy-own"))).toBe(true);
});

test("a lane the operator paused is not the seat's work: no stall, no interval wake (#2063)", async () => {
  const pipelines = [{
    id: "pipeline_op", state: "paused", createdAt: new Date(NOW - 300 * MINUTE).toISOString(),
    movedAt: new Date(NOW - 200 * MINUTE).toISOString(), stateDetail: "paused by operator",
  }];
  /* The proposal slot is spent, so the only wake left to raise is the stall
     this lane used to produce every hour. */
  const rig = harness({ pipelines, state: { ...OVERDUE, stalledSeen: ["pipeline_op"], lastProposalAt: new Date(NOW - 60 * MINUTE).toISOString() } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(rig.sent).toHaveLength(0);
});

test("a chat-filed question owes a bridge question report, and only matching durable report evidence clears it", async () => {
  const { scopedReportId } = await import("@/lib/bridge/store");
  const transcript = path.join(SESSIONS, "seat-question.jsonl");
  const question = "Should the prepared release proceed?";
  fs.writeFileSync(transcript, JSON.stringify({ type: "message", timestamp: new Date(NOW).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: question }] },
  }) + "\n");
  const rig = harness({ seat: { conversationId: CONVERSATION, seatEpoch: 7, path: transcript },
    settings: { ...defaultSeatTickSettings(PROJECT), wakeIntervalMinutes: 10 },
    state: { lastWakeAt: new Date(NOW).toISOString(), lastProposalAt: new Date(NOW).toISOString() },
  });
  const setId = "rsg_chat_question";
  const key = `ask:${setId}`;
  const log: import("@/lib/bridge/types").BridgeReportV1[] = [];
  rig.deps.sources!.reports = { ...reportPort(() => log), suggestions: () => ({ admissions: [], sets: [{
    conversationId: CONVERSATION, setId, at: new Date(NOW).toISOString(),
    origin: { kind: "manager", conversationId: CONVERSATION, role: "orchestrator" },
    replies: [{ label: "Proceed", text: "Proceed with the release" }],
  }] }) };
  const fileReport = (reportKey: string, seq: number) => log.push({
    id: scopedReportId(PROJECT, reportKey), key: reportKey, seq, at: new Date(NOW + 16 * MINUTE).toISOString(),
    class: "question", body: question, project: PROJECT,
    origin: { kind: "manager", conversationId: CONVERSATION, role: "orchestrator" },
  });
  rig.deps.sources!.now = () => NOW + 15 * MINUTE;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).not.toContain("Ask owed");
  expect(rig.sent[0]!.text).toContain("Question report owed");
  expect(rig.sent[0]!.text).toContain(`bridge_report with class: question, key ${key}`);
  fileReport("ask:rsg_other", 1);
  rig.deps.sources!.now = () => NOW + 30 * MINUTE;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(2);
  expect(rig.written.at(-1)!.asksOwed!.map(ask => ask.key)).toEqual([key]);
  fileReport(key, 2);
  rig.deps.sources!.now = () => NOW + 45 * MINUTE;
  expect((await runSeatTickCheck(PROJECT, rig.deps))!.verdict).toBe("quiet");
  expect(rig.written.at(-1)!.asksOwed).toEqual([]);
  expect(rig.sent).toHaveLength(2);
});

test.each([false, true])("five production-size settlements credit only complete rendered items and deliver the cropped remainder later (held: %s)", async (held) => {
  const ids = Array.from({ length: 5 }, (_, index) => [String(index).padStart(8, "0"), "0000", "4000", "8000", "0".repeat(12)].join("-"));
  const lanes = ids.map(id => ({
    ...pipelineRecord({ ...settledLane, id }),
    task: "Settlement title ".padEnd(119, "s"),
    taskFinishWaits: [{ taskId: "waiting-task", open: ["other-lane-a", "other-lane-b"] }],
  }));
  const rig = harness({ ...(held ? { delivery: HELD } : {}), settings: { ...defaultSeatTickSettings(PROJECT),
    monitorPrompt: "Standing monitor note ".padEnd(7_622, "n"), reason: "Operator instructions ".padEnd(500, "i"),
  } });
  rig.deps.sources!.pipelines = () => lanes as never;
  await runSeatTickCheck(PROJECT, rig.deps);
  const text = rig.sent[0]!.text;
  expect(text.length).toBeLessThanOrEqual(4_000);
  const complete = ids.filter(id => agendaOf(text).some(line => line.includes(id) && line.endsWith("task waits for 2 open pipelines")));
  expect(complete).toHaveLength(4);
  if (held) {
    expect(rig.written.at(-1)!.announcedLanes).toEqual([]);
    expect(rig.written.at(-1)!.outstandingWake!.commit.announcedLanes).toEqual(complete.map(id => `${id}:completed`));
    rig.deps.sources!.wakeState = async () => "landed";
    rig.deps.sources!.now = () => NOW + MINUTE;
    await runSeatTickCheck(PROJECT, rig.deps);
    rig.deps.deliver = async message => {
      rig.sent.push(message);
      return { ok: true, target: "structured", outcome: "delivered", structured: true };
    };
  }
  expect(rig.written.at(-1)!.announcedLanes).toEqual(complete.map(id => `${id}:completed`));
  const unseen = ids.filter(id => !complete.includes(id));
  rig.deps.sources!.now = () => NOW + 70 * MINUTE;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(2);
  for (const id of unseen) expect(agendaOf(rig.sent[1]!.text).some(line => line.includes(id) && line.endsWith("task waits for 2 open pipelines"))).toBe(true);
  expect(rig.written.at(-1)!.announcedLanes.sort()).toEqual(ids.map(id => `${id}:completed`).sort());
});

test("a legacy retained wake credits four complete settlements and delivers the unseen fifth later", async () => {
  const { gatherSeatTickInput } = await import("./seatTickSources");
  const { seatTickDecision, seatTickWakeCommitPlan } = await import("./seatTick");
  const ids = Array.from({ length: 5 }, (_, index) => [String(index).padStart(8, "0"), "0000", "4000", "8000", "1".repeat(12)].join("-"));
  const lanes = ids.map(id => ({ ...pipelineRecord({ ...settledLane, id }),
    task: "Settlement title ".padEnd(119, "s"),
    taskFinishWaits: [{ taskId: "waiting-task", open: ["other-lane-a", "other-lane-b"] }],
  }));
  const rig = harness({ delivery: HELD, settings: { ...defaultSeatTickSettings(PROJECT),
    monitorPrompt: "Standing monitor note ".padEnd(7_622, "n"), reason: "Operator instructions ".padEnd(500, "i"),
  } });
  rig.deps.sources!.pipelines = () => lanes as never;
  const initial = rig.deps.readState!(PROJECT);
  const input = await gatherSeatTickInput(PROJECT, initial, DEFAULT_SEAT_TICK_POLICY, rig.deps.sources!);
  const decision = seatTickDecision(input);
  expect(decision.verdict.kind).toBe("wake");
  const legacyCommit = seatTickWakeCommitPlan(decision.verdict, { fingerprint: input.changeFingerprint, eventsThrough: 0 })!;
  delete legacyCommit.itemLines;
  delete legacyCommit.itemsShown;
  delete legacyCommit.acknowledgmentLines;
  await runSeatTickCheck(PROJECT, rig.deps);
  const row = rig.deps.readState!(PROJECT);
  const wake = { ...row.outstandingWake!, commit: legacyCommit };
  const complete = ids.filter(id => agendaOf(wake.text!).some(line => line.includes(id) && line.endsWith("task waits for 2 open pipelines")));
  expect(complete).toHaveLength(4);
  expect(legacyCommit.announcedLanes).toHaveLength(5);
  rig.deps.writeState!(PROJECT, { ...row, outstandingWake: wake });
  rig.deps.sources!.wakeState = async observed => {
    expect(observed.clientMessageId).toBe(wake.clientMessageId);
    expect(observed.text).toBe(wake.text);
    return "landed";
  };
  rig.deps.sources!.now = () => NOW + MINUTE;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written.at(-1)!.announcedLanes).toEqual(complete.map(id => `${id}:completed`));
  rig.deps.deliver = async message => { rig.sent.push(message); return { ok: true, target: "structured", outcome: "delivered", structured: true }; };
  rig.deps.sources!.now = () => NOW + 70 * MINUTE;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(2);
  expect(agendaOf(rig.sent[1]!.text).some(line => line.includes(ids[4]!) && line.endsWith("task waits for 2 open pipelines"))).toBe(true);
  expect(rig.written.at(-1)!.announcedLanes.sort()).toEqual(ids.map(id => `${id}:completed`).sort());
});

test.each(["child", "deploy", "maintenance", "stall"] as const)("legacy retained %s credits only complete bullets through controller settlement", async kind => {
  const { seatTickWakeMessage, seatTickBullet } = await import("./report");
  const { seatTickWakeCommitPlan } = await import("./seatTick");
  const ids = Array.from({ length: 5 }, (_, index) => kind === "child"
    ? ["conversation", String(index).padStart(16, "0")].join("_") : `legacy-${kind}-${index}`);
  const items: import("./types").SeatTickItem[] = ids.map(id => ({
    id, kind: kind === "stall" ? "pipeline" : kind,
    label: "Settlement ".padEnd(500, "s"),
    ...(kind === "child" ? { outcomeId: id, stateTokens: [`${id}@one`] } : {}),
    ...(kind === "deploy" ? { deploy: { deploymentId: id, phase: "succeeded", sha: "a".repeat(40), error: null } } : {}),
    ...(kind === "maintenance" ? { maintenance: { runId: id } } : {}),
    ...(kind === "stall" ? { stallToken: `${id}@one` } : {}),
  }));
  const verdict: Extract<import("./types").SeatTickVerdict, { kind: "wake" }> = {
    kind: "wake", items, reasons: [{ kind: "interval", detail: "pending settlements" }], deferred: 0,
    gaps: [], skippedChildren: { stale: 0, unreadable: 0, unchanged: 0 },
  };
  const text = seatTickWakeMessage({ project: PROJECT, items, reasons: verdict.reasons, deferred: 0, signals: [],
    operatorInstructions: "Instructions ".padEnd(500, "i"), monitorPrompt: "Note ".padEnd(7_622, "n"),
  });
  const complete = items.filter(item => text.includes(`\n${seatTickBullet(item)}\n`));
  expect(complete.length).toBeGreaterThan(0);
  expect(complete.length).toBeLessThan(items.length);
  const commit = seatTickWakeCommitPlan(verdict, { fingerprint: "legacy", eventsThrough: 0, terminalChildren: ids })!;
  delete commit.acknowledgmentLines;
  delete commit.itemLines;
  delete commit.itemsShown;
  const outstandingWake = {
    clientMessageId: `legacy-${kind}-wake`, conversationId: CONVERSATION, seatEpoch: 7, operationId: null,
    preparedAt: new Date(NOW - MINUTE).toISOString(), text, commit,
  };
  const rig = harness({ wakeState: "landed" });
  let row: SeatTickProjectState = { ...emptySeatTickState(), seatEpoch: 7, outstandingWake };
  rig.deps.readState = () => row;
  rig.deps.writeState = (_project, next) => { row = next; };
  await runSeatTickCheck(PROJECT, rig.deps);
  const ledger = (state: SeatTickProjectState) => kind === "child" ? state.harvestedChildren
    : kind === "deploy" ? state.announcedDeploys : kind === "maintenance" ? state.announcedMaintenance : state.reportedStalls;
  const keys = (entries: typeof items) => entries.map(item => kind === "stall" ? item.stallToken! : item.id);
  expect(ledger(rig.deps.readState!(PROJECT))).toEqual(keys(complete));
  if (kind === "child") expect(rig.deps.readState!(PROJECT).childrenShown).toEqual(complete.map(item => `${item.id}@one`));

  // A later bounded wake proves the remainder, including opaque identities
  // that a pre-upgrade record could not bind to its displayed source id.
  const remaining = items.filter(item => !complete.includes(item));
  const next = { ...verdict, items: remaining };
  const nextText = seatTickWakeMessage({ project: PROJECT, items: remaining, reasons: next.reasons, deferred: 0, signals: [] });
  const nextCommit = seatTickWakeCommitPlan(next, { fingerprint: "new", eventsThrough: 0, terminalChildren: ids, frozenText: nextText })!;
  rig.deps.writeState!(PROJECT, { ...rig.deps.readState!(PROJECT), outstandingWake: {
    clientMessageId: `new-${kind}-wake`, conversationId: CONVERSATION, seatEpoch: 7, operationId: null,
    preparedAt: new Date(NOW + MINUTE).toISOString(), text: nextText, commit: nextCommit,
  } });
  rig.deps.sources!.now = () => NOW + 2 * MINUTE;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(ledger(rig.deps.readState!(PROJECT))).toEqual(keys(items));
});

test.each([30, 200])("full report ledgers deliver a complete maintenance settlement within two wakes and retain unrelated debt (label chars: %s)", async labelChars => {
  const { emptyMaintenanceCounts, emptyMaintenanceLog } = await import("@/lib/boardMaintenance/types");
  const { maintenanceItemLabel, parseMaintenanceReport } = await import("@/lib/boardMaintenance/text");
  const at = new Date(NOW).toISOString();
  const reportsOwed = Array.from({ length: 64 }, (_, index) => ({
    key: `lane:owed-${index}:completed`, label: `Genuine settlement ${index} `.padEnd(labelChars, "l"), receivedAt: at,
  }));
  const asksOwed = Array.from({ length: 16 }, (_, index) => ({
    key: `ask:rsg_${String(index).padStart(32, "0")}`, setId: `rsg_${String(index).padStart(32, "0")}`,
    conversationId: CONVERSATION, at,
  }));
  const attention = parseMaintenanceReport(Array.from({ length: 5 }, (_, index) =>
    `attention: ${String(index).padStart(8, "0")} | ${"Attention ".padEnd(300, "a")} | ${"Option ".padEnd(300, "o")} | ${"Alternative ".padEnd(300, "b")} | waits: start implementation`,
  ).join("\n")).attention;
  const run: import("@/lib/boardMaintenance/types").MaintenanceRun = {
    kind: "run", runId: "maintenance-full-ledger", taskId: "maintenance-card", project: PROJECT,
    slot: 1, intervalHours: 3, claimedAt: at, launchedAt: at, endedAt: at, state: "succeeded",
    seat: { seatEpoch: 7, conversationId: CONVERSATION }, repoDir: null, clientAttemptId: "fixture-maintenance",
    launchId: null, conversationId: null, transcriptPath: null, failure: null,
    log: { ...emptyMaintenanceLog(), attention }, counts: emptyMaintenanceCounts(), changedTaskIds: [], supersededTaskIds: [],
  };
  const rig = harness({ seat: { conversationId: CONVERSATION, seatEpoch: 7, path: null, mandate: "Custom older mandate", promptVersion: 20 },
    settings: { ...defaultSeatTickSettings(PROJECT), monitorPrompt: "Standing note ".padEnd(7_622, "n"), reason: "Instructions ".padEnd(500, "i") },
    state: { reportsOwed, asksOwed },
  });
  rig.deps.sources!.maintenanceRuns = () => [run];
  rig.deps.sources!.reports = { ...reportPort(() => []), suggestions: () => ({ admissions: [], sets: [{
    conversationId: CONVERSATION, setId: asksOwed.at(-1)!.setId, at,
    origin: { kind: "manager", conversationId: CONVERSATION, role: "orchestrator" },
    replies: [{ label: "Proceed", text: "Proceed with the prepared work" }],
  }] }) };
  for (let round = 0; round < 2; round++) {
    rig.deps.sources!.now = () => NOW + round * 70 * MINUTE;
    await runSeatTickCheck(PROJECT, rig.deps);
    expect(rig.sent.at(-1)!.text.length).toBeLessThanOrEqual(4_000);
    expect(rig.written.at(-1)!.reportsOwed).toEqual(reportsOwed);
    expect(rig.written.at(-1)!.asksOwed).toEqual(asksOwed);
    for (const ask of asksOwed) expect(rig.sent.at(-1)!.text).toContain(ask.key);
  }
  const bullet = `- [maintenance] ${run.taskId} — ${maintenanceItemLabel(run)}`;
  expect(bullet.length).toBeGreaterThan(1_200);
  if (labelChars === 200) expect(rig.sent.some(message => message.text.includes(`\n${bullet}\n`))).toBe(true);
  else expect(agendaOf(rig.sent.at(-1)!.text)).toEqual([expect.stringContaining("[summary; seat_tick_settings verbose:true holds the full item]")]);
  expect(rig.written.at(-1)!.announcedMaintenance).toEqual([run.runId]);
});

test("the controller keeps unpaid report reminders after the delivered agenda drains, until its matching bridge report lands", async () => {
  const { scopedReportId } = await import("@/lib/bridge/store");
  const rig = harness({ pipelines: [settledLane, ...OPEN_LANE] });
  const log: import("@/lib/bridge/types").BridgeReportV1[] = [];
  rig.deps.sources!.reports = reportPort(() => log);
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
  const key = `lane:${settledLane.id}:completed`;
  for (let round = 1; round <= DEFAULT_SEAT_TICK_POLICY.retryGuard + 2; round++) {
    rig.deps.sources!.now = () => NOW + round * 70 * MINUTE;
    await runSeatTickCheck(PROJECT, rig.deps);
    expect(rig.sent).toHaveLength(round + 1);
    expect(agendaOf(rig.sent.at(-1)!.text)).toEqual([expect.stringContaining("[pipeline]")]);
    expect(rig.sent.at(-1)!.text).toContain(`key ${key}`);
  }
  log.push({ id: scopedReportId(PROJECT, key), key, seq: 1, at: new Date(NOW + 500 * MINUTE).toISOString(),
    class: "completed", body: "Outcome reported", project: PROJECT,
    origin: { kind: "manager", conversationId: CONVERSATION, role: "orchestrator" },
  });
  rig.deps.sources!.now = () => NOW + 510 * MINUTE;
  expect((await runSeatTickCheck(PROJECT, rig.deps))!.reasons).toEqual(["interval"]);
  expect(rig.sent.at(-1)!.text).not.toContain(`key ${key}`);
  expect(rig.written.at(-1)!.reportsOwed).toEqual([]);
});

test("deploy snapshots are taken in the pass before the decision and the send, whether or not a wake goes out", async () => {
  const order: string[] = [];
  const rig = harness({ ...reportDeploys, state: { lastWakeAt: new Date(NOW - 6 * MINUTE).toISOString() } });
  rig.deps.sources!.recordDeploySnapshots = (project) => { order.push(`snapshot:${project}`); };
  const deliver = rig.deps.deliver!;
  rig.deps.deliver = async (message) => { order.push("send"); return deliver(message); };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(order).toEqual([`snapshot:${PROJECT}`, "send"]);

  const quiet = harness({ state: RECENT });
  const seen: string[] = [];
  quiet.deps.sources!.recordDeploySnapshots = (project) => { seen.push(project); };
  expect((await runSeatTickCheck(PROJECT, quiet.deps))!.verdict).toBe("quiet");
  expect(seen).toEqual([PROJECT]);
});

test("the lifecycle projection runs over the pipelines before the journal is paged", async () => {
  const order: string[] = [];
  const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, eventsThrough: 0 } });
  const journal = rig.deps.sources!.lifecycleJournal;
  rig.deps.sources!.refreshLifecycle = (pipelines) => { order.push(`refresh:${pipelines.length}`); };
  rig.deps.sources!.lifecycleJournal = () => { order.push("journal"); return journal(); };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(order.slice(0, 2)).toEqual(["refresh:1", "journal"]);
});

test("every terminal deployment in the ledger gets a snapshot, the operator's and a rotated seat's included, once each", async () => {
  const { snapshotSettledDeploys } = await import("./seatTickSources");
  const { projectSnapshots, resetTaskChangeCollectionsForTests } = await import("@/lib/bridge/taskChanges");
  resetTaskChangeCollectionsForTests();
  const status = (deploymentId: string, phase: string, terminal: boolean) => ({
    deploymentId, revision: REPORT_SHA, phase, terminal, updatedAt: new Date(NOW - MINUTE).toISOString(),
  });
  /* No seat record is read: an operator's deploy and one a predecessor seat
     started are both only in the ledger. */
  const ledger = { state: "ok" as const, value: [status("deploy-operator", "succeeded", true), status("deploy-seat-a", "failed", true), status("deploy-running", "promoting", false)] as never };
  const project = `${PROJECT}-snapshots`;
  expect(snapshotSettledDeploys(project, ledger, () => [])).toBe(2);
  expect(snapshotSettledDeploys(project, ledger, () => [])).toBe(0);
  expect(projectSnapshots(project).map((snapshot) => snapshot.deploymentId).sort()).toEqual(["deploy-operator", "deploy-seat-a"]);
});

test("a wake whose delivery was queued and is credited a check later is settled by a coversOwed report filed before the credit", async () => {
  const { scopedReportId } = await import("@/lib/bridge/store");
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "report-ledger-")), "seat-tick.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, lastWakeAt: new Date(NOW - 6 * MINUTE).toISOString(), accounting: undefined }, stateFile);
  const log: import("@/lib/bridge/types").BridgeReportV1[] = [];

  const first = harness({ ...reportDeploys, pipelines: [settledLane], stateFile });
  first.deps.sources!.reports = reportPort(() => log);
  const record = await runSeatTickCheck(PROJECT, { ...first.deps, deliver: async (message) => { first.sent.push(message); return HELD; } });
  expect(record!.delivery!.outcome).toBe("held");
  const text = first.sent[0]!.text;
  expect(text).toContain("Bridge reports:");
  expect(text).toContain("- Report owed, in Ukrainian, before this turn ends: deploy dddddddd succeeded");
  expect(text).toContain("File one report with key deploy:dddddddd:succeeded and coversOwed: true.");

  /* The seat got the wake a minute after it was sent and filed one report
     with coversOwed two minutes later; the check that credits the wake runs
     five minutes after the first. */
  const filedAt = new Date(NOW + 3 * MINUTE).toISOString();
  log.push({ id: scopedReportId(PROJECT, "deploy:dddddddd:succeeded"), seq: 1, at: filedAt, class: "completed", body: "", project: PROJECT, origin: { kind: "manager", conversationId: CONVERSATION, role: "orchestrator" }, coversOwedAt: filedAt });
  const second = harness({ ...reportDeploys, pipelines: [settledLane, ...OPEN_LANE], stateFile, now: NOW + 5 * MINUTE });
  second.deps.sources!.reports = reportPort(() => log);
  second.deps.sources!.wakeState = async () => ({
    state: "landed",
    evidence: { operationId: null, record: { state: "delivered", reason: null, resend: null, settledAt: new Date(NOW + MINUTE).toISOString() }, journal: "unasked" },
  }) as never;
  await runSeatTickCheck(PROJECT, second.deps);
  const row = readSeatTickState(PROJECT, stateFile);
  expect(row.reportsOwed).toEqual([]);

  /* The next wake carries no owed line. */
  const third = harness({ pipelines: OPEN_LANE, stateFile, now: NOW + 70 * MINUTE });
  third.deps.sources!.reports = reportPort(() => log);
  await runSeatTickCheck(PROJECT, third.deps);
  expect(third.sent).toHaveLength(1);
  expect(third.sent[0]!.text).not.toContain("Report owed");
});

test("a report the seat filed under the project's old key, before the key was folded, discharges the owed outcome", async () => {
  const { scopedReportId } = await import("@/lib/bridge/store");
  const { persistProjectAliases, resetProjectAliasesForTests } = await import("@/lib/projects/aliases");
  const OLD = `${PROJECT}-before-origin`;
  expect(persistProjectAliases([{ source: OLD, target: PROJECT, displayName: "Project" }])).toBe(true);
  try {
    const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "report-ledger-")), "seat-tick.json");
    writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, lastWakeAt: new Date(NOW - 6 * MINUTE).toISOString(), accounting: undefined }, stateFile);
    const log: import("@/lib/bridge/types").BridgeReportV1[] = [];
    const first = harness({ ...reportDeploys, pipelines: [settledLane], stateFile });
    first.deps.sources!.reports = reportPort(() => log);
    await runSeatTickCheck(PROJECT, first.deps);
    expect(readSeatTickState(PROJECT, stateFile).reportsOwed!.map((entry) => entry.key).sort()).toEqual(["deploy:dddddddd:succeeded", "lane:pipeline_l:completed"]);

    /* The row as bridge_report stored it before the fix: the raw project and an
       id scoped by it, with no coversOwed to clear everything at once. */
    log.push({ id: scopedReportId(OLD, "deploy:dddddddd:succeeded"), seq: 1, at: new Date(NOW + 2 * MINUTE).toISOString(), class: "completed", body: "", project: OLD, origin: { kind: "manager", conversationId: CONVERSATION, role: "orchestrator" }, covers: [scopedReportId(OLD, "lane:pipeline_l:completed")] });
    const second = harness({ ...reportDeploys, pipelines: [settledLane, ...OPEN_LANE], stateFile, now: NOW + 5 * MINUTE });
    second.deps.sources!.reports = reportPort(() => log);
    await runSeatTickCheck(PROJECT, second.deps);
    const row = readSeatTickState(PROJECT, stateFile);
    expect(row.reportsOwed).toEqual([]);
    expect(row.reportSeenAt).toBe(log[0]!.at);
  } finally {
    fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), { force: true });
    resetProjectAliasesForTests();
  }
});


test("maintenance settles before gather and launches after the wake; scratch check never opts in", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const order: string[] = [];
  const deliver = rig.deps.deliver!;
  rig.deps.deliver = async (...args) => { order.push("wake"); return deliver(...args); };
  rig.deps.maintenance = { reconcile: async () => { order.push("settle"); return "maintenance: fixture settled"; }, launchIfDue: async () => { order.push("launch"); return "maintenance: fixture launched"; } };
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(order).toEqual(["settle", "wake", "launch"]); expect(record?.detail).toContain("maintenance: fixture settled"); expect(record?.detail).toContain("maintenance: fixture launched");
});


test("restart wakes a confirmed lane stall despite a missing MCP heartbeat, once per unchanged stall", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "restart-stall-")), "seat-tick.json");
  const options = { pipelines: [{ id: "restart-lane", state: "running", createdAt: new Date(NOW - 60 * MINUTE).toISOString(), movedAt: new Date(NOW - 50 * MINUTE).toISOString(), attemptState: "running", attemptConversationId: "stage-conversation", src: CONVERSATION }], state: OVERDUE, stateFile };
  const before = harness(options);
  let seatGone = false;
  const liveness: NonNullable<SeatTickControllerDependencies["sources"]>["liveness"] = async request => request.conversationId === CONVERSATION
    ? seatGone ? [{ conversationId: CONVERSATION, host: { state: "gone", kind: "structured", pid: null }, lifecycle: "gone", reason: "host_gone_turn_settled", turnState: "idle" } as AgentLivenessRecord] : []
    : [{ conversationId: "stage-conversation", pipeline: { pipelineId: "restart-lane", stageId: "build", attempt: 1 }, lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "busy" } as AgentLivenessRecord];
  before.deps.sources!.liveness = liveness;
  before.deps.mcpHealth = () => ({ status: "dead", detail: "stdio MCP has no heartbeat" });
  await runSeatTickCheck(PROJECT, before.deps);
  expect(before.sent).toHaveLength(0);
  seatGone = true;
  // A new controller reads the first observation from the isolated disk store.
  const restarted = harness({ ...options, state: undefined });
  restarted.deps.sources!.liveness = liveness;
  restarted.deps.mcpHealth = before.deps.mcpHealth;
  const record = await runSeatTickCheck(PROJECT, restarted.deps);
  expect(record?.delivery?.outcome).toBe("delivered");
  expect(restarted.sent).toHaveLength(1);
  await runSeatTickCheck(PROJECT, restarted.deps);
  expect(restarted.sent).toHaveLength(1);
});

test("seat clock checks immediately after restart before its first interval", async () => {
  let checks = 0;
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "restart-clock-")), "seat-tick.json");
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, stateFile });
  const ports = { policy: DEFAULT_SEAT_TICK_POLICY, handoffHeld: () => false,
    recordSuccessions: () => [], scheduleInterval: () => ({ unref() {} }) as never,
    sweep: async () => { checks += 1; await runSeatTickCheck(PROJECT, rig.deps); } };
  startSeatTick(ports);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(checks).toBe(1);
  stopSeatTick();
  startSeatTick(ports);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(checks).toBe(2);
});

test("a second interruption parking an announced running stall wakes its seat despite unchanged movement", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "restart-park-wake-")), "seat-tick.json");
  const lane = { id: "restart-lane", state: "running", createdAt: new Date(NOW - 60 * MINUTE).toISOString(), movedAt: new Date(NOW - 50 * MINUTE).toISOString(), attemptState: "running", attemptConversationId: "stage-conversation", src: CONVERSATION };
  const first = harness({ pipelines: [lane], state: OVERDUE, stateFile });
  const liveness: NonNullable<SeatTickControllerDependencies["sources"]>["liveness"] = async request => request.conversationId === CONVERSATION
    ? [{ conversationId: CONVERSATION, host: { state: "gone", kind: "structured", pid: null }, lifecycle: "gone", reason: "host_gone_turn_settled", turnState: "idle" } as AgentLivenessRecord]
    : [{ conversationId: "stage-conversation", pipeline: { pipelineId: lane.id, stageId: "build", attempt: 1 }, lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "busy" } as AgentLivenessRecord];
  first.deps.sources!.liveness = liveness;
  first.deps.mcpHealth = () => ({ status: "dead", detail: "stdio MCP has no heartbeat" });
  await runSeatTickCheck(PROJECT, first.deps);
  await runSeatTickCheck(PROJECT, first.deps);
  expect(first.sent).toHaveLength(1);
  const parked = harness({ pipelines: [{ ...lane, state: "needs_decision", attemptState: "needs_decision" }], stateFile, now: NOW + 61 * MINUTE });
  parked.deps.sources!.liveness = liveness;
  parked.deps.mcpHealth = first.deps.mcpHealth;
  expect((await runSeatTickCheck(PROJECT, parked.deps))?.delivery?.outcome).toBe("delivered");
  expect(parked.sent).toHaveLength(1);
  await runSeatTickCheck(PROJECT, parked.deps);
  expect(parked.sent).toHaveLength(1);
});

test("a wake's journal settlement waits for the lock off the loop, and a write the lock refused answers undecided until the next tick", async () => {
  /* docs/design/delivery-progress-and-drain.md, C2. */
  const { sqliteRegistryFixture, registryLockHolder, whileRegistryWriterHeld } = await import("@/lib/agent/registryLockHolderFixture");
  const made = sqliteRegistryFixture("llv-wake-settlement", { sqliteWriterDeadlineMs: 150 });
  const holder = registryLockHolder(made.sqliteFilename);
  const registry = made.registry;
  try {
    const conversation = registry.ensureConversation("codex", "/wake-settlement.jsonl", "default");
    const held = registry.holdDelivery(conversation.id, "seat wake", "wake-settlement-key");
    registry.beginDeliveryAttempt(held.id, held.generationId!);
    const target = { conversationId: conversation.id, operationId: held.command.operationId, deliveryId: held.id };
    await holder.hold();
    const { value: refused } = await whileRegistryWriterHeld(holder, () => settleRecordFromJournal(registry, target, { status: "delivered", reason: null }), { release: false });
    expect(refused).toBeNull();

    await holder.release();
    expect(await settleRecordFromJournal(registry, target, { status: "delivered", reason: null })).toMatchObject({ state: "delivered" });
  } finally {
    await holder.close();
    registry.close();
    made.cleanup();
  }
});

// Authentication recovery drives the actual transcript, selector, seat command,
// bridge and Telegram service. Only process launch and bot HTTP are replaced.
describe("seat authentication recovery through production seams", () => {
  const AUTH_AT = "2026-10-08T00:05:00.000Z";
  const AUTH_TS = Date.parse(AUTH_AT);
  const ERROR_TEXT = "Failed to authenticate: OAuth session expired and could not be refreshed";

  async function authFixture(allowed: boolean, run: (fixture: Awaited<ReturnType<typeof makeAuthFixture>>) => Promise<void>, engine: "claude" | "codex" = "claude", history = false) {
    const previous = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_CLAUDE_HOME: process.env.LLV_CLAUDE_HOME, LLV_CODEX_HOME: process.env.LLV_CODEX_HOME };
    const dir = fs.mkdtempSync(path.join(SANDBOX, "auth-case-"));
    process.env.LLV_STATE_DIR = path.join(dir, "state");
    process.env.LLV_CLAUDE_HOME = path.join(dir, "legacy-claude");
    process.env.LLV_CODEX_HOME = path.join(dir, "legacy-codex");
    let fixture: Awaited<ReturnType<typeof makeAuthFixture>> | undefined;
    try { fixture = await makeAuthFixture(dir, allowed, engine, history); await run(fixture); }
    finally {
      await fixture?.telegram.stopPoller();
      setAgentRegistryForTests(null);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }

  async function makeAuthFixture(dir: string, allowed: boolean, engine: "claude" | "codex", history: boolean) {
    const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
    const { BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
    const { seedAccountSource, persistedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
    const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
    const { executeOrchestratorRotation, productionSeatCommandDependencies } = await import("@/lib/orchestrator/seatCommand");
    const { defaultSeatTickSources } = await import("./seatTickSources");
    const { setReportTelegram } = await import("@/lib/projects/settings");
    const { writeSeatTickSettings, readSeatTickSettingsFile } = await import("./seatTickSettings");
    const { readBridgeReportLog } = await import("@/lib/bridge/store");
    const { loadTasks } = await import("@/lib/tasks/store");
    const { TelegramBotService, productionTelegramBotDependencies } = await import("@/lib/telegram/bot/service");
    const { FakeBotTransport, fakeBotToken, ok } = await import("@/lib/telegram/bot/fakeTransport");
    const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
    const create = engine === "claude" ? createManagedClaudeAccount : createManagedCodexAccount;
    const a = create("Account A");
    const b = create("Account B");
    const transcriptRoot = (account: typeof a) => "projectsDir" in account ? account.projectsDir : account.sessionsDir;
    for (const account of [a, b]) {
      const credentials = path.join(account.home, engine === "claude" ? ".credentials.json" : "auth.json");
      fs.writeFileSync(credentials, "{}", { mode: 0o600 });
      const beforeFailure = new Date(AUTH_TS - MINUTE);
      fs.utimesSync(credentials, beforeFailure, beforeFailure);
    }
    const binding = { schemaVersion: 1, bindings: (allowed ? [a, b] : [a]).map((account) => ({ engine, accountId: account.id, project: PROJECT, createdAt: AUTH_AT })) };
    seedAccountSource(BINDINGS_SOURCE, binding);
    // The current account migration tombstones the legacy JSON path. Both
    // that directory and the durable binding rows must remain untouched.
    const bindingFile = statePath("account-project-bindings.json");
    const bindingStat = fs.statSync(bindingFile);
    expect(bindingStat.isDirectory()).toBe(true);
    const bindingEntries = fs.readdirSync(bindingFile);
    const storedBinding = JSON.stringify(persistedAccountSource(BINDINGS_SOURCE));
    const transcript = path.join(transcriptRoot(a), "fixture", `${crypto.randomUUID()}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    function appendTurn(error: string | null = "authentication_failed", at = AUTH_AT, providerText = ERROR_TEXT) {
      if (engine === "codex") {
        fs.appendFileSync(transcript, JSON.stringify({ type: "event_msg", timestamp: at, payload: { type: "task_started" } }) + "\n"
          + JSON.stringify({ type: "event_msg", timestamp: at, payload: { type: "error", message: providerText, error_type: error } }) + "\n"
          + JSON.stringify({ type: "event_msg", timestamp: at, payload: { type: "task_complete", error: { message: providerText, codex_error_info: "authentication_failed" } } }) + "\n");
        return;
      }
      fs.appendFileSync(transcript, JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: "seat tick" } }) + "\n"
        + JSON.stringify({ type: "assistant", timestamp: at, ...(error ? { error, isApiErrorMessage: true } : {}),
          message: { model: error ? "<synthetic>" : "fixture-model", role: "assistant", ...(error === "authentication_failed" ? {} : { stop_reason: "end_turn" }),
            content: [{ type: "text", text: error === "authentication_failed" ? providerText : error ? "You've hit your session limit" : "Work is complete." }] } }) + "\n");
    }
    appendTurn();
    const registry = new AgentRegistry(path.join(dir, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
    registry.setEngineRouting(engine, a.id);
    const capacity = (accountId: string, usedPercent: number) => {
      const now = Date.now();
      registry.recordQuotaObservation({ engine, accountId, authenticated: true,
        authCheckedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), bootId: "auth-fixture",
        limits: engine === "claude"
          ? { session: { usedPercent, resetsAt: Math.floor(now / 1000) + 3600 }, weekly: null, plan: "max", capturedAt: Math.floor(now / 1000) }
          : { session: { usedPercent, resetsAt: Math.floor(now / 1000) + 3600, windowMinutes: 300 }, weekly: null, plan: "pro", capturedAt: Math.floor(now / 1000) },
        provenance: { source: "live", reason: null, staleSince: null } });
    };
    capacity(a.id, 5); capacity(b.id, 20);
    const conversation = registry.ensureConversation(engine, transcript, null);
    registry.reconcileConversations([{ engine, path: transcript, accountId: a.id,
      launchProfile: emptyLaunchProfile({ cwd: dir }), turn: { state: "idle", source: "assistant", terminalAt: AUTH_AT }, observedAt: AUTH_AT }]);
    setAgentRegistryForTests(registry);
    beginOrchestratorSeatIntent({ project: PROJECT, mandate: "Own the board and report results." + (history ? "\n\n## Rotation history\nPrior decisions" : ""), engine, model: engine === "claude" ? "opus" : "gpt-6-astra", clientRequestId: "seed_auth_fixture", mode: "spawn", now: "2026-10-08T00:00:00Z" });
    completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "seed_auth_fixture", conversationId: conversation.id, path: transcript, now: "2026-10-08T00:00:00Z" });
    const original = orchestratorSeatFor(PROJECT).active!;
    const successorPath = path.join(transcriptRoot(b), "fixture", `${crypto.randomUUID()}.jsonl`);
    fs.mkdirSync(path.dirname(successorPath), { recursive: true }); fs.writeFileSync(successorPath, "");
    const successor = registry.ensureConversation(engine, successorPath, null);
    const spawns: Record<string, unknown>[] = [];
    const command: import("@/lib/orchestrator/seatCommand").SeatCommandDependencies = {
      spawn: async (body) => {
        spawns.push(body);
        expect(body.accountId).toBe(b.id);
        return { status: 200, body: { ok: true, conversationId: successor.id, path: successorPath } };
      },
      deliver: async () => ({ ok: true, outcome: "delivered" }),
      conversationTarget: productionSeatCommandDependencies.conversationTarget,
      resolvedConversation: productionSeatCommandDependencies.resolvedConversation,
      summarizeHandoffs: productionSeatCommandDependencies.summarizeHandoffs,
      launchSettlement: productionSeatCommandDependencies.launchSettlement,
      stampRegistryIdentity: productionSeatCommandDependencies.stampRegistryIdentity,
      runtimeIdentity: productionSeatCommandDependencies.runtimeIdentity,
      now: () => "2026-10-08T00:06:00.000Z",
    };
    const transport = new FakeBotTransport();
    transport.script("getMe", ok({ id: 4242424, is_bot: true, first_name: "Fixture Bot", username: "fixture_bot", can_join_groups: true }));
    let messageId = 1;
    transport.handlers.sendMessage = () => ok({ message_id: messageId++, date: 1, chat: { id: -1000000000101, type: "supergroup", title: "Fixture" }, text: "sent" });
    const telegram = new TelegramBotService({ ...productionTelegramBotDependencies(), transportFor: () => transport,
      now: () => new Date(AUTH_AT), sleep: async () => {}, conversationTitle: () => null });
    await telegram.connect(fakeBotToken()); await telegram.stopPoller();
    transport.script("getUpdates", ok([{ update_id: 1, my_chat_member: { chat: { id: -1000000000101, type: "supergroup", title: "Fixture" }, date: 1, new_chat_member: { status: "member" } } }]));
    await telegram.pollOnce(new AbortController().signal);
    telegram.setChat("-1000000000101", "auth-fixture", true);
    const chat = telegram.listChats().chats[0]!.alias!;
    setReportTelegram(PROJECT, { chat, name: "Fixture" }, "fixture");
    writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), monitorPrompt: "Keep reporting owed work" });
    const noteBefore = JSON.stringify(readSeatTickSettingsFile());
    let clock = AUTH_TS + 2 * 60 * MINUTE;
    const rig = harness({ registry, now: clock });
    rig.deps.sources!.seatFor = orchestratorSeatFor;
    rig.deps.sources!.seatTurnOutcome = defaultSeatTickSources().seatTurnOutcome;
    rig.deps.sources!.now = () => clock;
    rig.deps.readState = readSeatTickState;
    rig.deps.writeState = writeSeatTickState;
    rig.deps.reconcileSeat = () => null;
    delete rig.deps.ensureCard;
    const sendRequests: string[] = [];
    rig.deps.seatAuth = { rotate: (body, _dependencies, actor, admission) => executeOrchestratorRotation(body, command, actor, admission), telegram: async (input) => { sendRequests.push(String(input.clientRequestId)); return telegram.send(input); } };
    function migrateAccount(accountId: string, targetPath: string, at: string) {
      const id = original.conversationId! as Parameters<typeof registry.requestConversationReseat>[0];
      const requested = registry.requestConversationReseat(id, accountId);
      const revision = requested.migration!.revision;
      registry.transitionConversationMigration(id, revision, ["requested"], { phase: "preparing" });
      const starting = registry.transitionConversationMigration(id, revision, ["preparing"], { phase: "successor-starting" });
      const receipt: import("@/lib/accounts/migration/contracts").ProviderReceipt = {
        operationId: starting.migration!.operationId, nativeId: "fixture-manual-moved", path: targetPath, continuityPaths: [targetPath], historyHash: "fixture",
        host: { kind: "claude-fork", identity: "fixture", epoch: 1, verifiedAt: at },
      };
      registry.persistMigrationProviderReceipt(id, revision, starting.migration!.operationId, receipt);
      registry.commitSuccessor(id, { id: "fixture-manual-moved", path: targetPath, accountId }, revision, starting.migration!.operationId, receipt);
    }
    async function restartAuthentication(credentialReader?: string) {
      const active = orchestratorSeatFor(PROJECT).active!;
      const activeTranscript = registry.conversation(active.conversationId! as Parameters<typeof registry.conversation>[0])?.generations.at(-1)?.path ?? active.path ?? transcript;
      const script = `
        ${credentialReader ?? ""}
        const { recoverSeatAuthentication } = await import("./src/lib/monitor/seatAuthRecovery");
        const { readSeatTurnOutcome } = await import("./src/lib/monitor/seatAuthIncident");
        const { readSeatTickState, writeSeatTickState } = await import("./src/lib/monitor/seatTickState");
        const { defaultSeatTickSources } = await import("./src/lib/monitor/seatTickSources");
        const project = ${JSON.stringify(PROJECT)};
        const input = { project, now: ${clock}, state: readSeatTickState(project),
          seat: ${JSON.stringify({ conversationId: active.conversationId, seatEpoch: active.seatEpoch, path: activeTranscript, designatedAt: active.designatedAt, turn: "idle", activity: null })} };
        const unexpected = () => { throw new Error("restart attempted another authentication effect"); };
        await recoverSeatAuthentication(input, { ...defaultSeatTickSources(), seatTurnOutcome: () => readSeatTurnOutcome(${JSON.stringify(engine)}, ${JSON.stringify(activeTranscript)}) },
          readSeatTickState, writeSeatTickState, readSeatTickState(project).authCardsOwed?.length ? () => false : unexpected, { rotate: unexpected,
            telegram: readSeatTickState(project).authTelegramOwed?.length ? async () => { throw Object.assign(new Error("fixture restart refusal"), { code: "bot_not_connected" }); } : unexpected });
        writeSeatTickState(project, input.state);
        console.log(JSON.stringify(readSeatTickState(project)));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      const errors = await new Response(child.stderr).text();
      expect({ status: await child.exited, errors }).toEqual({ status: 0, errors: "" });
      return JSON.parse(output) as SeatTickProjectState;
    }
    return { a, b, original, successor, transcript, registry, command, rig, spawns, telegram, transport, appendTurn, capacity, sendRequests, restartAuthentication, migrateAccount,
      check: async () => { const result = await runSeatTickCheck(PROJECT, rig.deps); clock += 5 * MINUTE; return result; },
      seat: () => orchestratorSeatFor(PROJECT).active!, row: () => readSeatTickState(PROJECT),
      reports: () => readBridgeReportLog().reports, cards: () => loadTasks(statePath("tasks.json")).filter((task) => task.text.includes("monitor-ref: seat-auth-failed")),
      unchangedBinding: () => { expect(fs.statSync(bindingFile).ino).toBe(bindingStat.ino); expect(fs.readdirSync(bindingFile)).toEqual(bindingEntries); expect(JSON.stringify(persistedAccountSource(BINDINGS_SOURCE))).toBe(storedBinding); },
      unchangedNote: () => expect(JSON.stringify(readSeatTickSettingsFile())).toBe(noteBefore),
    };
  }

  for (const engine of ["claude", "codex"] as const) {
    test(`${engine}: touching unchanged credentials before first detection still reports and parks`, async () => {
      await authFixture(false, async (f) => {
        const file = path.join(f.a.home, engine === "claude" ? ".credentials.json" : "auth.json");
        const touch = new Date("2026-10-08T00:06:00Z");
        fs.utimesSync(file, touch, touch);
        await f.check(); await f.check();
        expect(f.row().authIncident?.rotation.state).toBe("none-allowed");
        expect(f.reports()).toHaveLength(1);
        expect(f.cards()).toHaveLength(1);
        expect(f.rig.sent).toHaveLength(0);
        expect((await f.restartAuthentication()).authIncident?.id).toBe(f.row().authIncident?.id);
        fs.writeFileSync(file, '{"repaired":true}', { mode: 0o600 });
        await f.check();
        expect(f.row().authIncident).toBeUndefined();
        expect(f.rig.sent.length).toBeGreaterThan(0);
      }, engine);
    });
  }

  test("an empty Codex completion cannot promote an older assistant answer into recovery evidence", async () => {
    await authFixture(false, async (f) => {
      const oldAnswer = JSON.stringify({ type: "response_item", timestamp: "2026-10-08T00:01:00Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Earlier work completed." }] } }) + "\n";
      fs.writeFileSync(f.transcript, oldAnswer + fs.readFileSync(f.transcript, "utf8"));
      await f.check();
      const id = f.row().authIncident!.id;
      for (const type of ["task_started", "task_complete"]) fs.appendFileSync(f.transcript,
        JSON.stringify({ type: "event_msg", timestamp: "2026-10-08T00:08:00Z", payload: { type } }) + "\n");
      await f.check(); await f.check();
      expect(f.row().authIncident?.id).toBe(id);
      expect(f.rig.sent).toHaveLength(0);
      expect(f.reports()).toHaveLength(1);
      expect((await f.restartAuthentication()).authIncident?.id).toBe(id);
    }, "codex");
  });

  test.each(["login", "migration"] as const)("a board capacity refusal retains the authentication notice through %s", async (recovery) => {
    await authFixture(false, async (f) => {
      const { BOARD_TASKS_PER_PROJECT_LIMIT, createTask } = await import("@/lib/tasks/commands");
      const { mutateTasksFile } = await import("@/lib/tasks/store");
      const tasksFile = statePath("tasks.json");
      mutateTasksFile((loaded) => {
        let tasks = loaded.tasks, receipts = loaded.recentCreates;
        for (let index = 0; index < BOARD_TASKS_PER_PROJECT_LIMIT; index++) {
          const created = createTask(tasks, { project: PROJECT, text: `Fixture capacity ${index}`, placement: "unplaced" }, receipts);
          if (!created.ok) throw new Error(created.error);
          tasks = created.tasks; receipts = created.recentCreates;
        }
        return { state: { tasks, recentCreates: receipts }, result: true };
      }, tasksFile);
      await f.check();
      expect(f.cards()).toHaveLength(0);
      expect(f.row().authIncident?.notice?.card).toBe(false);
      expect(f.reports()).toHaveLength(1);
      const id = f.row().authIncident!.id;
      if (recovery === "login") fs.writeFileSync(path.join(f.a.home, ".credentials.json"), '{"repaired":true}', { mode: 0o600 });
      else f.migrateAccount(f.b.id, f.registry.conversation(f.successor.id)!.generations.at(-1)!.path, "2026-10-08T02:10:00Z");
      await f.check();
      expect(f.row().authIncident).toBeUndefined();
      expect(f.rig.sent.length).toBeGreaterThan(0);
      expect(f.row().authCardsOwed?.map(notice => notice.id)).toEqual([id]);
      expect((await f.restartAuthentication()).authCardsOwed?.map(notice => notice.id)).toEqual([id]);
      mutateTasksFile((loaded) => ({ state: { ...loaded, tasks: loaded.tasks.map(task => ({ ...task, board: "hidden" as const })) }, result: true }), tasksFile);
      await f.check(); await f.check();
      expect(f.cards()).toHaveLength(1);
      expect(f.cards()[0]?.status).toBe("done");
      expect(f.row().authIncident).toBeUndefined();
      expect(f.reports()).toHaveLength(1);
      expect(f.sendRequests.every(key => key === id)).toBe(true);
      expect(f.transport.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      expect(f.rig.sent.length).toBeGreaterThan(0);
    });
  });

  test("login before first detection consumes the failed turn across restart", async () => {
    await authFixture(false, async (f) => {
      const credentials = path.join(f.a.home, ".credentials.json");
      fs.writeFileSync(credentials, '{"refreshed":true}', { mode: 0o600 });
      const login = new Date("2026-10-08T00:06:00Z");
      fs.utimesSync(credentials, login, login);
      await f.check(); await f.check();
      expect(f.row().authIncident).toBeUndefined();
      expect(f.row().authRecoveredThrough).toBe(AUTH_TS);
      expect(f.rig.sent.length).toBeGreaterThan(0);
      expect(f.reports()).toHaveLength(0);
      expect((await f.restartAuthentication()).authRecoveredThrough).toBe(AUTH_TS);
      f.appendTurn("authentication_failed", "2026-10-08T00:08:00Z");
      await f.check();
      expect(f.row().authIncident?.firstFailedAt).toBe("2026-10-08T00:08:00.000Z");
      expect(f.reports()).toHaveLength(1);
    });
  });

  test("Keychain login clears the card and consumes the incident across restart", async () => {
    await authFixture(false, async (f) => {
      fs.rmSync(path.join(f.a.home, ".credentials.json"));
      const credentials = await import("@/lib/accounts/claudeCredentials");
      let generation = "fixture-old-access";
      const read = spyOn(credentials, "readClaudeCredentials").mockImplementation(() => ({
        state: "present", source: "keychain", document: { claudeAiOauth: { accessToken: generation } },
      }));
      try {
        await f.check();
        expect(f.row().authIncident?.rotation.state).toBe("none-allowed");
        const persisted = JSON.stringify(f.row());
        expect(persisted).not.toContain(generation);
        generation = "fixture-repaired-access";
        await f.check(); await f.check();
        expect(f.row().authIncident).toBeUndefined();
        expect(f.cards()[0]?.status).toBe("done");
        expect(f.rig.sent.length).toBeGreaterThan(0);
        expect(f.reports()).toHaveLength(1);
        const afterRestart = await f.restartAuthentication(`
          const { spyOn } = await import("bun:test");
          const credentials = await import("./src/lib/accounts/claudeCredentials");
          const generation = ${JSON.stringify(generation)};
          spyOn(credentials, "readClaudeCredentials").mockImplementation(() => ({
            state: "present", source: "keychain", document: { claudeAiOauth: { accessToken: generation } },
          }));
        `);
        expect(afterRestart.authIncident).toBeUndefined();
        expect(afterRestart.authRecoveredThrough).toBe(AUTH_TS);
        f.appendTurn("authentication_failed", "2026-10-08T00:08:00Z");
        await f.check();
        expect(f.reports()).toHaveLength(2);
      } finally { read.mockRestore(); }
    });
  });

  test.each([false, true])("Keychain metadata availability changes preserve unchanged credentials with initial metadata=%s", async (available) => {
    await authFixture(false, async (f) => {
      fs.rmSync(path.join(f.a.home, ".credentials.json"));
      const credentials = await import("@/lib/accounts/claudeCredentials");
      let generation = "fixture-old-access";
      let modifiedAt: number | null = available ? AUTH_TS - MINUTE : null;
      const read = spyOn(credentials, "readClaudeCredentials").mockImplementation(() => ({
        state: "present", source: "keychain", document: { claudeAiOauth: { accessToken: generation } },
      }));
      const metadata = spyOn(credentials, "claudeKeychainCredentialChangedAt").mockImplementation(() => modifiedAt);
      try {
        await f.check();
        modifiedAt = available ? null : AUTH_TS - MINUTE;
        await f.check(); await f.check();
        expect(f.row().authIncident?.rotation.state).toBe("none-allowed");
        expect(f.rig.sent).toHaveLength(0); expect(f.cards()[0]?.status).toBe("inbox");
        expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
        expect((await f.restartAuthentication(`
          const { spyOn } = await import("bun:test");
          const credentials = await import("./src/lib/accounts/claudeCredentials");
          const generation = ${JSON.stringify(generation)};
          spyOn(credentials, "readClaudeCredentials").mockImplementation(() => ({ state: "present", source: "keychain", document: { claudeAiOauth: { accessToken: generation } } }));
          spyOn(credentials, "claudeKeychainCredentialChangedAt").mockReturnValue(${modifiedAt});
        `)).authIncident?.rotation.state).toBe("none-allowed");
        generation = "fixture-repaired-access";
        modifiedAt = AUTH_TS + MINUTE;
        await f.check();
        expect(f.row().authIncident).toBeUndefined(); expect(f.cards()[0]?.status).toBe("done");
        expect(f.rig.sent).toHaveLength(1);
      } finally { read.mockRestore(); metadata.mockRestore(); }
    });
  });

  test("a changed Keychain credential cannot hide an unobserved newer authentication failure", async () => {
    await authFixture(false, async (f) => {
      fs.rmSync(path.join(f.a.home, ".credentials.json"));
      const credentials = await import("@/lib/accounts/claudeCredentials");
      let generation = "fixture-old-access";
      const read = spyOn(credentials, "readClaudeCredentials").mockImplementation(() => ({
        state: "present", source: "keychain", document: { claudeAiOauth: { accessToken: generation } },
      }));
      try {
        await f.check();
        generation = "fixture-repaired-access";
        f.appendTurn("authentication_failed", "2026-10-08T00:08:00Z");
        await f.check();
        expect(f.row().authIncident?.lastFailedTs).toBe(Date.parse("2026-10-08T00:08:00Z"));
        expect(f.reports()).toHaveLength(2);
        expect(f.rig.sent).toHaveLength(0);
        await f.check();
        expect(f.reports()).toHaveLength(2);
      } finally { read.mockRestore(); }
    });
  });

  test.each([false, true])("Keychain repair consumes preceding failures with prior detection=%s", async (detected) => {
    await authFixture(false, async (f) => {
      fs.rmSync(path.join(f.a.home, ".credentials.json"));
      const credentials = await import("@/lib/accounts/claudeCredentials");
      let generation = "fixture-old-access";
      let modifiedAt = AUTH_TS - MINUTE;
      const read = spyOn(credentials, "readClaudeCredentials").mockImplementation(() => ({
        state: "present", source: "keychain", document: { claudeAiOauth: { accessToken: generation } },
      }));
      const metadata = spyOn(credentials, "claudeKeychainCredentialChangedAt").mockImplementation(() => modifiedAt);
      try {
        if (detected) await f.check();
        f.appendTurn("authentication_failed", "2026-10-08T00:08:00Z");
        generation = "fixture-repaired-access";
        modifiedAt = Date.parse("2026-10-08T00:10:00Z");
        await f.check(); await f.check();
        expect(f.row().authIncident).toBeUndefined();
        expect(f.row().authRecoveredThrough).toBe(Date.parse("2026-10-08T00:08:00Z"));
        expect(f.rig.sent.length).toBeGreaterThan(0);
        expect(f.reports()).toHaveLength(detected ? 1 : 0);
        f.appendTurn("authentication_failed", "2026-10-08T00:12:00Z");
        await f.check();
        expect(f.reports()).toHaveLength(detected ? 2 : 1);
      } finally { read.mockRestore(); metadata.mockRestore(); }
    });
  });

  test("a verified healthy account migration releases the prior account's fence before its first turn", async () => {
    await authFixture(false, async (f) => {
      await f.check();
      const targetPath = path.join(path.dirname(f.registry.conversation(f.successor.id)!.generations.at(-1)!.path), `${crypto.randomUUID()}.jsonl`);
      fs.writeFileSync(targetPath, "");
      f.migrateAccount(f.b.id, targetPath, "2026-10-08T02:10:00.000Z");
      await f.check();
      expect(f.row().authIncident).toBeUndefined(); expect(f.cards()[0]?.status).toBe("done");
      expect(f.rig.sent).toHaveLength(1); expect(f.spawns).toHaveLength(0);
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      expect((await f.restartAuthentication()).authIncident).toBeUndefined();
    });
  });

  test.each(["claude", "codex"] as const)("an aborted %s turn cannot clear an authentication incident", async (engine) => {
    await authFixture(false, async (f) => {
      await f.check();
      const at = "2026-10-08T02:10:00.000Z";
      const records = engine === "codex"
        ? [{ type: "event_msg", timestamp: at, payload: { type: "task_started" } }, { type: "event_msg", timestamp: at, payload: { type: "turn_aborted", reason: "interrupted" } }]
        : [{ type: "user", timestamp: at, message: { role: "user", content: "try again" } }, { type: "result", subtype: "interrupted", timestamp: at }];
      fs.appendFileSync(f.transcript, records.map((row) => JSON.stringify(row)).join("\n") + "\n");
      await f.check(); await f.check();
      expect(f.row().authIncident?.rotation.state).toBe("none-allowed"); expect(f.rig.sent).toHaveLength(0);
      expect(f.cards()[0]?.status).toBe("inbox"); expect(f.reports()).toHaveLength(1);
      expect((await f.restartAuthentication()).authIncident?.rotation.state).toBe("none-allowed");
    }, engine);
  });

  test("a terminal provider refusal cannot substitute for a successful authentication recovery turn", async () => {
    await authFixture(false, async (f) => {
      await f.check();
      f.appendTurn("rate_limit", "2026-10-08T02:10:00.000Z");
      await f.check();
      expect(f.row().authIncident?.rotation.state).toBe("none-allowed"); expect(f.rig.sent).toHaveLength(0);
    });
  });

  test.each(["claude", "codex"] as const)("touching unchanged %s credentials cannot clear authentication", async (engine) => {
    await authFixture(false, async (f) => {
      await f.check();
      const file = path.join(f.a.home, engine === "claude" ? ".credentials.json" : "auth.json");
      const touched = new Date("2026-10-08T02:10:00Z");
      fs.utimesSync(file, touched, touched);
      await f.check(); await f.check();
      expect(f.row().authIncident?.rotation.state).toBe("none-allowed"); expect(f.rig.sent).toHaveLength(0);
      expect(f.cards()[0]?.status).toBe("inbox"); expect(f.reports()).toHaveLength(1);
      expect((await f.restartAuthentication()).authIncident?.rotation.state).toBe("none-allowed");
      fs.writeFileSync(file, "{\"repaired\":true}");
      fs.utimesSync(file, touched, touched);
      await f.check();
      expect(f.row().authIncident).toBeUndefined(); expect(f.rig.sent).toHaveLength(1);
    }, engine);
  });

  test.each([[false, true], [true, true], [false, false]])("a known Telegram refusal retries independently with allowed=%s and bridge=%s", async (allowed, bridgeEnabled) => {
    await authFixture(allowed, async (f) => {
      if (!bridgeEnabled) (await import("@/lib/projects/settings")).setBridgeReports(PROJECT, false, "fixture");
      f.telegram.setChat("-1000000000101", "auth-fixture", false);
      await f.check();
      expect(f.row().authIncident?.notice?.telegram).toBe("failed");
      expect(f.transport.callsOf("sendMessage")).toHaveLength(0); expect(f.reports()).toHaveLength(bridgeEnabled ? 1 : 0);
      await f.check();
      expect((await f.restartAuthentication()).authTelegramOwed).toHaveLength(1);
      if (allowed) expect(f.rig.sent.length).toBeGreaterThan(0);
      const { drainFile, writeDrain, releaseDrain } = await import("@/lib/selfUpdate/drain");
      writeDrain(drainFile(), { id: "auth-telegram-retry-drain", target: "fixture", since: AUTH_AT, until: 0, persistent: true });
      try {
        f.telegram.setChat("-1000000000101", "auth-fixture", true);
        await f.check();
        expect(f.transport.callsOf("sendMessage")).toHaveLength(0);
        expect(f.row().authTelegramOwed).toHaveLength(1);
      } finally { releaseDrain(drainFile(), "auth-telegram-retry-drain"); }
      await f.check(); await f.check();
      expect(f.transport.callsOf("sendMessage")).toHaveLength(1); expect(f.reports()).toHaveLength(bridgeEnabled ? 1 : 0);
      expect(f.row().authTelegramOwed ?? []).toHaveLength(0);
      if (!allowed) expect(f.row().authIncident?.notice?.telegram).toBe("sent");
      expect(new Set(f.sendRequests).size).toBe(1);
    });
  });

  test("an uncertain Telegram send keeps its original receipt and is never posted twice", async () => {
    await authFixture(false, async (f) => {
      const { unreachable } = await import("@/lib/telegram/bot/fakeTransport");
      f.transport.handlers.sendMessage = () => unreachable("timed_out");
      await f.check(); await f.check();
      expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      expect(f.row().authTelegramOwed ?? []).toHaveLength(0);
      expect(f.reports()).toHaveLength(1); expect(f.cards()).toHaveLength(1);
    });
  });

  test("a migrated account's first authentication failure opens its own incident in the same seat epoch", async () => {
    await authFixture(false, async (f) => {
      await f.check();
      const first = f.row().authIncident!.id;
      const targetPath = path.join(path.dirname(f.registry.conversation(f.successor.id)!.generations.at(-1)!.path), `${crypto.randomUUID()}.jsonl`);
      const at = "2026-10-08T02:10:00.000Z";
      fs.writeFileSync(targetPath, JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: "manual account switch" } }) + "\n"
        + JSON.stringify({ type: "assistant", timestamp: at, error: "authentication_failed", isApiErrorMessage: true,
          message: { model: "<synthetic>", content: [{ type: "text", text: ERROR_TEXT }] } }) + "\n");
      f.migrateAccount(f.b.id, targetPath, at);
      f.capacity(f.a.id, 100);
      expect(f.seat().seatEpoch).toBe(f.original.seatEpoch);
      await f.check(); await f.check();
      expect(f.row().authIncident?.accountId).toBe(f.b.id);
      expect(f.row().authIncident?.id).not.toBe(first);
      expect(f.reports()).toHaveLength(2); expect(f.reports()[1]?.body).toContain("Account B");
      expect(f.transport.callsOf("sendMessage")).toHaveLength(2); expect(f.rig.sent).toHaveLength(0);
      expect(f.cards().filter((card) => card.status === "inbox")).toHaveLength(1);
      expect((await f.restartAuthentication()).authIncident?.accountId).toBe(f.b.id);
      await f.check(); expect(f.reports()).toHaveLength(2);
    });
  });

  test("first failure rotates once to the allowed account with handoff and one independent notice", async () => {
    await authFixture(true, async (f) => {
      await f.check();
      expect(f.spawns).toHaveLength(1); expect(f.spawns[0]!.accountId).toBe(f.b.id);
      expect(f.spawns[0]!.prompt).toContain("Automatic rotation after authentication failure");
      expect(f.seat().seatEpoch).toBe(f.original.seatEpoch + 1);
      expect(f.seat().predecessorConversationId).toBe(f.original.conversationId);
      f.unchangedNote(); f.unchangedBinding();
      expect(f.reports()).toHaveLength(1); expect(f.reports()[0]!.class).toBe("status");
      expect(f.reports()[0]!.origin).toMatchObject({ kind: "agent", role: "seat-tick", conversationId: null });
      expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      expect(f.cards()).toHaveLength(1); expect(f.cards()[0]!.status).toBe("done");
      f.appendTurn("authentication_failed", "2026-10-08T00:08:00Z");
      for (let n = 0; n < 3; n++) await f.check();
      expect(f.spawns).toHaveLength(1); expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
    });
  });

  test("none allowed parks once, names the outside account and resumes after re-login without stale reopening", async () => {
    await authFixture(false, async (f) => {
      expect((await f.check())?.delivery?.outcome).toBe("seat-auth-failed");
      expect(f.spawns).toHaveLength(0); expect(f.reports()).toHaveLength(1); expect(f.reports()[0]!.class).toBe("blocked");
      expect(f.reports()[0]!.body).toContain("Account B"); expect(f.reports()[0]!.body).toContain("увійдіть");
      expect(f.cards()[0]!.status).toBe("inbox"); f.unchangedBinding();
      f.appendTurn("authentication_failed", "2026-10-08T00:08:00Z");
      for (let n = 0; n < 3; n++) expect((await f.check())?.delivery?.outcome).toBe("seat-auth-failed");
      expect(f.rig.sent).toHaveLength(0); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      fs.writeFileSync(path.join(f.a.home, ".credentials.json"), "{\"refreshed\":true}", { mode: 0o600 });
      const login = new Date("2026-10-08T00:10:00Z");
      fs.utimesSync(path.join(f.a.home, ".credentials.json"), login, login);
      await f.check(); await f.check();
      expect(f.row().authIncident).toBeUndefined(); expect(f.rig.sent.length).toBeGreaterThan(0); expect(f.cards()[0]!.status).toBe("done");
      f.appendTurn("authentication_failed", "2026-10-08T00:30:00Z");
      await f.check(); expect(f.reports()).toHaveLength(2);
    });
  });

  test("login clears an unobserved failed turn and persists the recovery boundary across restart", async () => {
    await authFixture(false, async (f) => {
      await f.check();
      f.appendTurn("authentication_failed", "2026-10-08T00:08:00Z");
      fs.writeFileSync(path.join(f.a.home, ".credentials.json"), "{\"refreshed\":true}", { mode: 0o600 });
      const login = new Date("2026-10-08T00:10:00Z");
      fs.utimesSync(path.join(f.a.home, ".credentials.json"), login, login);
      await f.check();
      expect(f.row().authIncident).toBeUndefined();
      expect(f.row().authRecoveredThrough).toBe(Date.parse("2026-10-08T00:08:00Z"));
      expect(f.cards()[0]!.status).toBe("done");
      expect(f.rig.sent).toHaveLength(1);
      const persisted = await f.restartAuthentication();
      expect(persisted.authIncident).toBeUndefined();
      expect(persisted.authRecoveredThrough).toBe(f.row().authRecoveredThrough);
      await f.check();
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      f.appendTurn("authentication_failed", "2026-10-08T00:30:00Z");
      await f.check();
      expect(f.row().authIncident?.lastFailedTs).toBe(Date.parse("2026-10-08T00:30:00Z"));
      expect(f.reports()).toHaveLength(2);
    });
  });

  test("an authentication failure after login opens a new incident even before the next check", async () => {
    await authFixture(false, async (f) => {
      await f.check();
      const credentials = path.join(f.a.home, ".credentials.json");
      fs.writeFileSync(credentials, "{\"refreshed\":true}", { mode: 0o600 });
      const login = new Date("2026-10-08T00:07:00Z"); fs.utimesSync(credentials, login, login);
      f.appendTurn("authentication_failed", "2026-10-08T00:08:00Z");
      await f.check();
      expect(f.row().authIncident?.firstFailedAt).toBe("2026-10-08T00:08:00.000Z");
      expect(f.reports()).toHaveLength(2); expect(f.transport.callsOf("sendMessage")).toHaveLength(2);
      expect(f.rig.sent).toHaveLength(0);
      await f.check(); expect(f.reports()).toHaveLength(2);
    });
  });

  test("an unreadable binding parks selection and still sends one independent authentication notice", async () => {
    await authFixture(true, async (f) => {
      const { BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
      const { seedAccountSource, persistedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
      seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: "damaged" });
      const before = JSON.stringify(persistedAccountSource(BINDINGS_SOURCE));
      await f.check();
      expect(f.reports()).toHaveLength(1); expect(f.cards()).toHaveLength(1);
      expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      expect(f.reports()[0]!.body).toContain("не зміг автентифікуватися");
      expect(f.reports()[0]!.body).toContain("account-project-bindings.json");
      expect(f.reports()[0]!.body).not.toContain("Account B");
      expect(f.row().authIncident?.rotation.state).toBe("refused");
      expect((await f.restartAuthentication()).authIncident?.notice?.card).toBe(true);
      for (let n = 0; n < 3; n++) await f.check();
      expect(f.spawns).toHaveLength(0); expect(f.rig.sent).toHaveLength(0);
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      expect(JSON.stringify(persistedAccountSource(BINDINGS_SOURCE))).toBe(before);
    });
  });

  test.each(["binding", "capacity"] as const)("automatic recovery refuses a target whose %s changes during handoff", async (race) => {
    await authFixture(true, async (f) => {
      const { BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
      const { seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
      const { resolveHealthySpawnAccount } = await import("@/lib/accounts/manager");
      f.command.summarizeHandoffs = async () => {
        if (race === "binding") seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [{ engine: "codex", accountId: f.a.id, project: PROJECT, createdAt: AUTH_AT }] });
        else f.capacity(f.b.id, 100);
        return { kind: "fallback", reason: "unavailable" };
      };
      f.command.spawn = async (body) => {
        const account = await resolveHealthySpawnAccount(body.engine as "codex", body.accountId as string, body.project as string, body.model as string);
        f.spawns.push({ ...body, actualAccount: account.accountId });
        return { status: 200, body: { ok: true, conversationId: f.successor.id, path: f.transcript } };
      };
      await f.check(); await f.check();
      expect(f.spawns).toHaveLength(0);
      expect(f.row().authIncident?.rotation.state).toBe("refused");
      expect(f.seat().conversationId).toBe(f.original.conversationId);
      expect(f.rig.sent).toHaveLength(0);
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
    }, "codex", true);
  });

  test("a drain beginning during handoff holds automatic helpers, successors and notices until release", async () => {
    await authFixture(true, async (f) => {
      const { summarizeHandoffsHeadless, productionDigestRuntime } = await import("@/lib/orchestrator/handoffDigest");
      const { accountManager } = await import("@/lib/accounts/manager");
      let startDrain = true, helpers = 0;
      const lease = { id: "auth-handoff-drain", target: "fixture", since: AUTH_AT, until: 0, persistent: true };
      f.command.summarizeHandoffs = (request) => summarizeHandoffsHeadless(request, {
        ...productionDigestRuntime,
        resolveAccount: async () => {
          if (startDrain) { startDrain = false; writeDrain(drainFile(), lease); }
          return { kind: "available", account: accountManager.resolveSpawn("codex", f.b.id) };
        },
        run: async () => { helpers++; throw new Error("fixture helper unavailable"); },
      });
      try {
        await f.check(); await f.check();
        expect(helpers).toBe(0); expect(f.spawns).toHaveLength(0);
        expect(f.row().authIncident?.rotation.state).toBe("held");
        expect(f.reports()).toHaveLength(0); expect(f.transport.callsOf("sendMessage")).toHaveLength(0);
        expect(f.rig.sent).toHaveLength(0);
      } finally { releaseDrain(drainFile(), lease.id); }
      await f.check(); await f.check();
      expect(helpers).toBe(1); expect(f.spawns).toHaveLength(1);
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
    }, "codex", true);
  });

  test("automatic recovery carries drain admission to a refused successor and resumes the same pending intent", async () => {
    await authFixture(true, async (f) => {
      const spawn = f.command.spawn;
      const lease = { id: "auth-successor-drain", target: "fixture", since: AUTH_AT, until: 0, persistent: true };
      let attempt: unknown;
      f.command.spawn = async (body, autonomous, admission) => {
        expect(autonomous).toBe(true); expect(admission?.autonomous).toBe(true);
        attempt = body.clientAttemptId;
        writeDrain(drainFile(), lease);
        return { status: 503, body: { code: "AUTO_UPDATE_DRAIN", error: "held for update" } };
      };
      try {
        await f.check(); await f.check();
        expect(f.row().authIncident?.rotation.state).toBe("held");
        expect(f.reports()).toHaveLength(0); expect(f.transport.callsOf("sendMessage")).toHaveLength(0);
        expect(f.spawns).toHaveLength(0); expect(f.rig.sent).toHaveLength(0);
      } finally { releaseDrain(drainFile(), lease.id); }
      f.command.spawn = spawn;
      await f.check(); await f.check();
      expect(f.spawns).toHaveLength(1); expect(f.spawns[0]!.clientAttemptId).toBe(attempt);
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
    });
  });

  test("the first terminal authentication failure fences an outstanding original-key wake retry", async () => {
    await authFixture(false, async (f) => {
      fs.writeFileSync(f.transcript, ""); f.appendTurn(null, "2026-10-08T02:04:00Z");
      f.rig.deps.sources!.wakeState = async () => "absent";
      f.rig.deps.deliver = async (message) => {
        f.rig.sent.push(message);
        return { ok: false, outcome: "failed", status: 503, error: "temporary connection refusal" };
      };
      await f.check();
      const refused = f.row();
      expect(refused.outstandingWake?.dispatch?.state).toBe("refused");
      f.rig.sent.length = 0; f.appendTurn("authentication_failed", "2026-10-08T02:06:00Z");
      f.rig.deps.deliver = async (message) => {
        f.rig.sent.push(message);
        return { ok: true, target: "structured", outcome: "delivered", structured: true };
      };
      await f.check(); await f.check();
      expect(f.rig.sent).toHaveLength(0);
      expect(f.row().lastWakeAt).toBe(refused.lastWakeAt);
      expect(f.row().eventsThrough).toBe(refused.eventsThrough);
      expect(f.row().outstandingWake?.clientMessageId).toBe(refused.outstandingWake?.clientMessageId);
      expect(f.row().authIncident?.rotation.state).toBe("none-allowed");
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      fs.writeFileSync(path.join(f.a.home, ".credentials.json"), "{\"refreshed\":true}", { mode: 0o600 });
      await f.check(); await f.check();
      expect(f.rig.sent).toHaveLength(1);
      expect(f.rig.sent[0]!.clientMessageId).toBe(refused.outstandingWake?.clientMessageId);
      expect(f.row().authIncident).toBeUndefined(); expect(f.reports()).toHaveLength(1);
    });
  });

  test("a long provider diagnostic keeps the login action and outside-binding account in every notice", async () => {
    await authFixture(false, async (f) => {
      fs.writeFileSync(f.transcript, ""); f.appendTurn("authentication_failed", AUTH_AT, ERROR_TEXT + " detail".repeat(1000));
      await f.check();
      expect(f.reports()[0]!.body).toContain("увійдіть"); expect(f.reports()[0]!.body).toContain("Account B");
      expect(f.cards()[0]!.text).toContain("увійдіть");
      expect(String(f.transport.callsOf("sendMessage")[0]!.params.text)).toContain("увійдіть");
    });
  });

  test("an allowed alternative without capacity parks without widening the binding", async () => {
    await authFixture(true, async (f) => {
      f.capacity(f.b.id, 100); await f.check(); await f.check();
      expect(f.row().authIncident?.rotation.state).toBe("none-allowed");
      expect(f.spawns).toHaveLength(0); expect(f.rig.sent).toHaveLength(0);
      expect(f.reports()).toHaveLength(1); f.unchangedBinding();
    });
  });

  test("a newer normal terminal turn clears the fence and resolves the notice card", async () => {
    await authFixture(false, async (f) => {
      await f.check(); f.appendTurn(null, "2026-10-08T00:10:00Z"); await f.check();
      expect(f.row().authIncident).toBeUndefined(); expect(f.cards()[0]!.status).toBe("done"); expect(f.rig.sent).toHaveLength(1);
    });
  });

  test("usage limits, ordinary answers and pre-designation authentication failures keep ordinary wakes", async () => {
    for (const error of ["rate_limit", null, "old-auth"] as const) await authFixture(false, async (f) => {
      fs.writeFileSync(f.transcript, ""); f.appendTurn(error === "old-auth" ? "authentication_failed" : error, error === "old-auth" ? "2026-10-07T23:59:00Z" : AUTH_AT);
      await f.check(); expect(f.row().authIncident).toBeUndefined(); expect(f.reports()).toHaveLength(0); expect(f.rig.sent).toHaveLength(1);
    });
  });

  test("login during a drain preserves the unsent notice and resumes after release", async () => {
    await authFixture(false, async (f) => {
      const lease = { id: "auth-login-notice-drain", target: "fixture", since: AUTH_AT, until: 0, persistent: true };
      writeDrain(drainFile(), lease);
      try {
        await f.check();
        const id = f.row().authIncident!.id;
        fs.writeFileSync(path.join(f.a.home, ".credentials.json"), '{"repaired":true}', { mode: 0o600 });
        await f.check();
        expect(f.reports()).toHaveLength(0); expect(f.cards()).toHaveLength(0);
        expect(f.rig.sent).toHaveLength(0);
        expect((await f.restartAuthentication()).authIncident?.id).toBe(id);
        releaseDrain(drainFile(), lease.id);
        await f.check(); await f.check();
        expect(f.reports()).toHaveLength(1);
        expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
        expect(f.cards()).toHaveLength(1); expect(f.cards()[0]?.status).toBe("done");
        expect(f.row().authIncident).toBeUndefined(); expect(f.spawns).toHaveLength(0);
        expect(f.rig.sent.length).toBeGreaterThan(0);
      } finally { releaseDrain(drainFile(), lease.id); }
    });
  });

  test("a healthy native migration preserves its drain-held predecessor notice across restart", async () => {
    await authFixture(true, async (f) => {
      const lease = { id: "auth-migration-notice-drain", target: "fixture", since: AUTH_AT, until: 0, persistent: true };
      writeDrain(drainFile(), lease);
      try {
        await f.check();
        const id = f.row().authIncident!.id;
        const targetPath = f.registry.conversation(f.successor.id)!.generations.at(-1)!.path;
        f.migrateAccount(f.b.id, targetPath, "2026-10-08T00:08:00Z");
        await f.check();
        await f.restartAuthentication();
        expect(f.reports()).toHaveLength(0); expect(f.cards()).toHaveLength(0);
        releaseDrain(drainFile(), lease.id);
        await f.check(); await f.check();
        expect(f.reports()).toHaveLength(1);
        expect(f.sendRequests).toEqual([id]);
        expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
        expect(f.cards()).toHaveLength(1); expect(f.cards()[0]?.status).toBe("done");
        expect(f.reports()[0]?.body).toContain("Account A");
        expect(f.row().authIncident).toBeUndefined(); expect(f.spawns).toHaveLength(0);
        expect(f.rig.sent.length).toBeGreaterThan(0);
        await f.restartAuthentication(); await f.check();
        expect(f.reports()).toHaveLength(1); expect(f.sendRequests).toEqual([id]);
      } finally { releaseDrain(drainFile(), lease.id); }
    });
  });

  test("a failing native migration retains both drain-held account notices and decides recovery independently", async () => {
    await authFixture(true, async (f) => {
      const lease = { id: "auth-failed-migration-drain", target: "fixture", since: AUTH_AT, until: 0, persistent: true };
      writeDrain(drainFile(), lease);
      try {
        await f.check();
        const predecessorId = f.row().authIncident!.id;
        const targetPath = f.registry.conversation(f.successor.id)!.generations.at(-1)!.path;
        const at = "2026-10-08T00:08:00Z";
        fs.writeFileSync(targetPath, JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: "try again" } }) + "\n"
          + JSON.stringify({ type: "assistant", timestamp: at, error: "authentication_failed", isApiErrorMessage: true,
            message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: ERROR_TEXT }] } }) + "\n");
        f.migrateAccount(f.b.id, targetPath, at);
        await f.check();
        const successorId = f.row().authIncident!.id;
        expect(successorId).not.toBe(predecessorId);
        expect(f.row().authIncident?.accountId).toBe(f.b.id);
        expect((await f.restartAuthentication()).authIncident?.id).toBe(successorId);
        let decisions = 0;
        f.rig.deps.seatAuth!.rotate = async (body) => {
          decisions++;
          expect(body.accountId).toBe(f.a.id);
          return { status: 503, body: { error: "fixture migration recovery refused" } };
        };
        releaseDrain(drainFile(), lease.id);
        await f.check(); await f.check();
        expect(f.reports()).toHaveLength(2);
        expect(f.sendRequests).toEqual([predecessorId, successorId]);
        expect(f.transport.callsOf("sendMessage")).toHaveLength(2);
        expect(f.cards()).toHaveLength(2);
        expect(f.cards().map(card => card.status).sort()).toEqual(["done", "inbox"]);
        expect(f.reports()[0]?.body).toContain("Account A"); expect(f.reports()[1]?.body).toContain("Account B");
        expect(f.row().authIncident?.id).toBe(successorId);
        expect(f.row().authIncident?.rotation.state).toBe("refused");
        expect(f.rig.sent).toHaveLength(0); expect(decisions).toBe(1);
        await f.restartAuthentication(); await f.check(); await f.check();
        expect(f.reports()).toHaveLength(2); expect(f.sendRequests).toEqual([predecessorId, successorId]);
        expect(decisions).toBe(1);
      } finally { releaseDrain(drainFile(), lease.id); }
    });
  });

  test("a board storage exception preserves notice debt without fencing a repaired seat", async () => {
    await authFixture(false, async (f) => {
      f.rig.deps.ensureCard = () => { throw Object.assign(new Error("fixture board write refused"), { code: "EACCES" }); };
      await f.check();
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      fs.writeFileSync(path.join(f.a.home, ".credentials.json"), '{"repaired":true}', { mode: 0o600 });
      await f.check(); await f.check();
      expect(f.row().authIncident).toBeUndefined(); expect(f.rig.sent.length).toBeGreaterThan(0);
      expect(f.row().authCardsOwed).toHaveLength(1);
      expect((await f.restartAuthentication()).authCardsOwed).toHaveLength(1);
      delete f.rig.deps.ensureCard;
      await f.check(); await f.check();
      expect(f.row().authCardsOwed).toEqual([]);
      expect(f.cards()).toHaveLength(1); expect(f.cards()[0]?.status).toBe("done");
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
    });
  });

  test("an older owed card is delivered without replacing a newer incident's open card", async () => {
    await authFixture(false, async (f) => {
      f.rig.deps.ensureCard = () => false;
      await f.check();
      const oldId = f.row().authIncident!.id;
      fs.writeFileSync(path.join(f.a.home, ".credentials.json"), '{"repaired":true}', { mode: 0o600 });
      const login = new Date("2026-10-08T00:06:00Z"); fs.utimesSync(path.join(f.a.home, ".credentials.json"), login, login);
      await f.check();
      const older = f.row().authCardsOwed!;
      writeSeatTickState(PROJECT, { ...f.row(), authCardsOwed: [] });
      delete f.rig.deps.ensureCard;
      f.appendTurn("authentication_failed", "2026-10-08T00:08:00Z");
      await f.check();
      const current = f.row().authIncident!.id;
      expect(current).not.toBe(oldId); expect(f.cards()).toHaveLength(1);
      writeSeatTickState(PROJECT, { ...f.row(), authCardsOwed: older });
      await f.check(); await f.check();
      expect(f.row().authCardsOwed).toEqual([]);
      expect(f.row().authIncident?.id).toBe(current);
      expect(f.cards()).toHaveLength(2);
      expect(f.cards().filter(card => card.status === "inbox")).toHaveLength(1);
      expect(f.reports()).toHaveLength(2);
      expect(f.transport.callsOf("sendMessage")).toHaveLength(2);
    });
  });

  test("an update drain holds rotation and notice until the first check after release", async () => {
    await authFixture(true, async (f) => {
      const lease = { id: "auth-fixture-drain", target: "fixture", since: new Date().toISOString(), until: Date.now() + 60_000 };
      writeDrain(drainFile(), lease);
      try { await f.check(); expect(f.row().authIncident?.rotation.state).toBe("held"); expect(f.spawns).toHaveLength(0); expect(f.reports()).toHaveLength(0); expect(f.rig.sent).toHaveLength(0); }
      finally { releaseDrain(drainFile(), lease.id); }
      await f.check(); expect(f.spawns).toHaveLength(1); expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
    });
  });

  test("a drain starting after the rotation decision holds unsent authentication notices", async () => {
    await authFixture(false, async (f) => {
      let start = true;
      f.rig.deps.writeState = (project, row) => {
        writeSeatTickState(project, row);
        if (start && row.authIncident?.rotation.state === "none-allowed" && !row.authIncident.notice) {
          start = false;
          writeDrain(drainFile(), { id: "auth-notice-drain", target: "fixture", since: AUTH_AT, until: 0, persistent: true });
        }
      };
      try {
        await f.check(); await f.check();
        expect(f.spawns).toHaveLength(0);
        expect(f.rig.sent).toHaveLength(0);
        expect(f.reports()).toHaveLength(0);
        expect(f.transport.callsOf("sendMessage")).toHaveLength(0);
        expect(f.cards()).toHaveLength(0);
        releaseDrain(drainFile(), "auth-notice-drain");
        await f.check(); await f.check();
        expect(f.reports()).toHaveLength(1);
        expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
        expect(f.cards()).toHaveLength(1);
      } finally { releaseDrain(drainFile(), "auth-notice-drain"); }
    });
  });

  test.each(["full", "throws"] as const)("a readable authentication successor wakes while its predecessor's board notice %s", async (failure) => {
    await authFixture(true, async (f) => {
      f.rig.deps.ensureCard = () => {
        if (failure === "throws") throw new Error("fixture board writer unavailable");
        return false;
      };
      await f.check();
      const id = f.row().authIncident!.id;
      expect(f.seat().conversationId).toBe(f.successor.id);
      expect(f.row().authCardsOwed?.map(card => card.id)).toEqual([id]);
      if (failure === "full") expect((await f.restartAuthentication()).authIncident).toBeUndefined();
      await f.check();
      expect(f.row().authIncident).toBeUndefined();
      expect(f.rig.sent.length).toBeGreaterThan(0);
      expect(f.rig.sent.every(message => message.conversationId === f.successor.id)).toBe(true);
      const restarted = await f.restartAuthentication();
      expect(restarted.authIncident).toBeUndefined();
      expect(restarted.authCardsOwed?.map(card => ({ id: card.id, state: card.state }))).toEqual([{ id, state: "resolved" }]);
      expect(f.cards()).toHaveLength(0);
      delete f.rig.deps.ensureCard;
      await f.check(); await f.check();
      expect(f.row().authCardsOwed).toEqual([]);
      expect(f.cards()).toHaveLength(1);
      expect(f.cards()[0]?.status).toBe("done");
      expect(f.reports()).toHaveLength(1);
      expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      expect(f.spawns).toHaveLength(1);
    });
  });

  test.each(["reported", "drain-held"] as const)("a failed authentication successor gets its own notice while its predecessor's %s board card is owed", async (noticeState) => {
    await authFixture(true, async (f) => {
      f.rig.deps.ensureCard = () => false;
      const rotate = f.rig.deps.seatAuth!.rotate!;
      f.rig.deps.seatAuth!.rotate = async (...args) => {
        const result = await rotate(...args);
        if (noticeState === "drain-held") writeDrain(drainFile(), { id: "auth-board-debt-drain", target: "fixture", since: AUTH_AT, until: 0, persistent: true });
        return result;
      };
      try {
        await f.check();
        const predecessorId = f.row().authIncident!.id;
        const transcript = f.registry.conversation(f.successor.id)!.generations.at(-1)!.path;
        const at = "2026-10-08T00:08:00Z";
        fs.appendFileSync(transcript, JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: "initial mandate" } }) + "\n"
          + JSON.stringify({ type: "assistant", timestamp: at, error: "authentication_failed", isApiErrorMessage: true,
            message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: ERROR_TEXT }] } }) + "\n");
        releaseDrain(drainFile(), "auth-board-debt-drain");
        let successorRotations = 0;
        f.rig.deps.seatAuth!.rotate = async () => {
          successorRotations++;
          return { status: 503, body: { error: "fixture successor rotation refused" } };
        };
        await f.check();
        expect(f.row().authIncident?.conversationId).toBe(f.successor.id);
        const successorId = f.row().authIncident!.id;
        expect(successorId).not.toBe(predecessorId);
        await f.check();
        const restarted = await f.restartAuthentication();
        expect(restarted.authIncident?.id).toBe(successorId);
        expect(restarted.authIncident?.lastFailedTs).toBe(Date.parse(at));
        expect(restarted.authCardsOwed?.map(card => ({ id: card.id, state: card.state }))).toEqual([
          { id: predecessorId, state: "resolved" }, { id: successorId, state: "open" },
        ]);
        expect(f.reports()).toHaveLength(2);
        expect(f.transport.callsOf("sendMessage")).toHaveLength(2);
        expect(f.rig.sent).toHaveLength(0);
        expect(successorRotations).toBe(1);
        delete f.rig.deps.ensureCard;
        await f.check(); await f.check();
        expect(f.row().authCardsOwed).toEqual([]);
        expect(f.cards()).toHaveLength(2);
        expect(f.cards().map(card => card.status).sort()).toEqual(["done", "inbox"]);
        expect(f.row().authIncident?.id).toBe(successorId);
        expect(f.reports()).toHaveLength(2);
        expect(f.transport.callsOf("sendMessage")).toHaveLength(2);
        expect(successorRotations).toBe(1);
      } finally { releaseDrain(drainFile(), "auth-board-debt-drain"); }
    });
  });

  test("a successor authentication failure stays independent of its predecessor's held notice", async () => {
    await authFixture(true, async (f) => {
      const rotate = f.rig.deps.seatAuth!.rotate!;
      f.rig.deps.seatAuth!.rotate = async (...args) => {
        const result = await rotate(...args);
        writeDrain(drainFile(), { id: "auth-successor-drain", target: "fixture", since: AUTH_AT, until: 0, persistent: true });
        return result;
      };
      try {
        await f.check();
        const transcript = f.registry.conversation(f.successor.id)!.generations.at(-1)!.path;
        const at = "2026-10-08T00:08:00Z";
        fs.appendFileSync(transcript, JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: "initial mandate" } }) + "\n"
          + JSON.stringify({ type: "assistant", timestamp: at, error: "authentication_failed", isApiErrorMessage: true,
            message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: ERROR_TEXT }] } }) + "\n");
        await f.check();
        expect(f.row().authIncident?.lastFailedTs).toBe(AUTH_TS);
        expect(f.reports()).toHaveLength(0);
        expect((await f.restartAuthentication()).authIncident?.lastFailedTs).toBe(AUTH_TS);
        releaseDrain(drainFile(), "auth-successor-drain");
        // Refuse the successor's move independently of the completed first move.
        f.rig.deps.seatAuth!.rotate = async () => ({ status: 503, body: { error: "fixture successor rotation refused" } });
        await f.check(); await f.check(); await f.check();
        expect(f.reports()).toHaveLength(2);
        expect(f.row().authIncident?.conversationId).toBe(f.successor.id);
        expect(f.row().authIncident?.lastFailedTs).toBe(Date.parse(at));
        expect(f.rig.sent).toHaveLength(0);
        expect((await f.restartAuthentication()).authIncident?.lastFailedTs).toBe(Date.parse(at));
      } finally { releaseDrain(drainFile(), "auth-successor-drain"); }
    });
  });

  test("unreadable Codex credentials cannot clear an incident or suppress its notice", async () => {
    await authFixture(false, async (f) => {
      await f.check();
      const credentials = path.join(f.a.home, "auth.json");
      const openFile = fs.openSync;
      const unreadable = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
        if (args[0] === credentials) {
          throw Object.assign(new Error("fixture credential permission refused"), { code: "EACCES" });
        }
        return Reflect.apply(openFile, fs, args);
      });
      try {
        fs.writeFileSync(credentials, '{"refreshed":true}', { mode: 0o600 });
        await f.check(); await f.check();
        expect(f.row().authIncident?.rotation.state).toBe("none-allowed");
        expect(f.cards()[0]?.status).toBe("inbox");
        expect(f.reports()).toHaveLength(1);
        expect(f.rig.sent).toHaveLength(0);
      } finally { unreadable.mockRestore(); }
      const login = new Date("2026-10-08T00:10:00Z");
      fs.utimesSync(credentials, login, login);
      await f.check(); await f.check();
      expect(f.row().authIncident).toBeUndefined();
      expect(f.cards()[0]?.status).toBe("done");
      expect(f.rig.sent.length).toBeGreaterThan(0);
      expect(f.reports()).toHaveLength(1);
      expect((await f.restartAuthentication()).authIncident).toBeUndefined();
    }, "codex");
  });

  test("unsafe credentials preserve first-failure attribution and the independent notice", async () => {
    await authFixture(false, async (f) => {
      fs.chmodSync(path.join(f.a.home, ".credentials.json"), 0o644);
      await f.check(); await f.check();
      expect(f.row().authIncident?.accountId).toBe(f.a.id);
      expect(f.reports()).toHaveLength(1);
      expect(f.cards()).toHaveLength(1);
      expect(f.rig.sent).toHaveLength(0);
      expect(f.spawns).toHaveLength(0);
    });
  });

  test("compatible-provider credential repair clears the incident across restart and retains later failures", async () => {
    await authFixture(false, async (f) => {
      const { createManagedClaudeAccount, updateProviderClaudeAccount } = await import("@/lib/accounts/claude");
      const { BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
      const { seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
      const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
      const config = { baseUrl: "https://example.invalid/messages", model: "fixture-model", smallFastModel: null };
      const provider = createManagedClaudeAccount("Account Provider", { config, token: crypto.randomUUID() });
      const transcript = path.join(provider.projectsDir, "fixture", "provider-auth.jsonl");
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      const appendFailure = (at: string) => fs.appendFileSync(transcript,
        JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: "seat tick" } }) + "\n"
        + JSON.stringify({ type: "assistant", timestamp: at, error: "authentication_failed", isApiErrorMessage: true,
          message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: ERROR_TEXT }] } }) + "\n");
      // Provider metadata uses its real creation time. Put the failed turn
      // after that creation, then repair only after the turn has ended.
      const failureAt = new Date(Date.now() + 20).toISOString();
      appendFailure(failureAt);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const conversation = f.registry.ensureConversation("claude", transcript, null);
      f.registry.reconcileConversations([{ engine: "claude", path: transcript, accountId: provider.id,
        launchProfile: emptyLaunchProfile({ cwd: path.dirname(transcript) }),
        turn: { state: "idle", source: "assistant", terminalAt: failureAt }, observedAt: failureAt }]);
      seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [{ engine: "claude", accountId: provider.id, project: PROJECT, createdAt: AUTH_AT }] });
      beginOrchestratorSeatIntent({ project: PROJECT, mandate: "Own the board", engine: "claude", model: "fixture-model", clientRequestId: "provider_auth_fixture", mode: "spawn", now: "2026-10-08T00:00:00Z" });
      completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "provider_auth_fixture", conversationId: conversation.id, path: transcript, now: "2026-10-08T00:00:00Z" });
      await f.check();
      expect(f.row().authIncident?.rotation.state).toBe("none-allowed");
      const tokenFile = path.join(provider.home, ".provider-token");
      fs.utimesSync(tokenFile, new Date(), new Date());
      await f.check();
      expect(f.row().authIncident?.rotation.state).toBe("none-allowed"); expect(f.rig.sent).toHaveLength(0);
      updateProviderClaudeAccount(provider.id, config, crypto.randomUUID());
      await f.check(); await f.check();
      expect(f.row().authIncident).toBeUndefined();
      expect(f.cards()[0]?.status).toBe("done");
      expect(f.rig.sent.length).toBeGreaterThan(0);
      expect(f.reports()).toHaveLength(1);
      const afterRestart = await f.restartAuthentication();
      expect(afterRestart.authIncident).toBeUndefined();
      expect(afterRestart.authRecoveredThrough).toBe(Date.parse(failureAt));
      appendFailure(new Date(Date.now() + 20).toISOString());
      await f.check();
      expect(f.reports()).toHaveLength(2);
    });
  });

  test("a lost final state write replays the real bridge, bot and board receipts without another notice", async () => {
    await authFixture(false, async (f) => {
      let failOnce = true;
      f.rig.deps.writeState = (project, row) => {
        if (failOnce && row.authIncident?.notice?.card) { failOnce = false; throw new Error("lost state write"); }
        writeSeatTickState(project, row);
      };
      await f.check(); await f.check();
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1); expect(f.cards()).toHaveLength(1);
      expect(f.row().authIncident?.notice?.card).toBe(true);
      expect(f.sendRequests).toHaveLength(2); expect(new Set(f.sendRequests).size).toBe(1);
    });
  });

  test("a rotation that lands before its outcome write is recovered from the durable request identity", async () => {
    await authFixture(true, async (f) => {
      let failOnce = true;
      f.rig.deps.writeState = (project, row) => {
        if (failOnce && row.authIncident?.rotation.state === "rotated" && !row.authIncident.notice) {
          failOnce = false; throw new Error("lost rotation outcome write");
        }
        writeSeatTickState(project, row);
      };
      await f.check(); await f.check(); await f.check();
      expect(f.spawns).toHaveLength(1); expect(f.reports()).toHaveLength(1);
      expect(f.transport.callsOf("sendMessage")).toHaveLength(1); expect(f.cards()).toHaveLength(1);
      expect(f.cards()[0]!.status).toBe("done");
    });
  });

  test("a refused allowed-account rotation parks the seat and tells the operator the refusal", async () => {
    await authFixture(true, async (f) => {
      f.command.spawn = async () => ({ status: 503, body: { error: "fixture launch refused" } });
      await f.check(); await f.check();
      expect(f.row().authIncident?.rotation.state).toBe("refused");
      expect(f.rig.sent).toHaveLength(0); expect(f.reports()).toHaveLength(1);
      expect(f.reports()[0]!.body).toContain("fixture launch refused");
      expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
    });
  });

  test("a failed launch receipt returned with HTTP 200 cannot claim authentication recovery", async () => {
    await authFixture(true, async (f) => {
      f.command.spawn = async () => ({ status: 200, body: { ok: false, launched: false, state: "failed", error: "fixture terminal launch failure" } });
      await f.check(); await f.check();
      expect(f.seat().conversationId).toBe(f.original.conversationId);
      expect(f.row().authIncident?.rotation.state).toBe("refused");
      expect(f.reports()).toHaveLength(1);
      expect(f.reports()[0]?.class).toBe("blocked");
      expect(f.reports()[0]?.body).toContain("fixture terminal launch failure");
      expect(f.cards()[0]?.status).toBe("inbox");
      expect(f.rig.sent).toHaveLength(0);
    });
  });

  test("login before provisional successor materialization uses its launch credential baseline", async () => {
    await authFixture(true, async (f) => {
      const { confirmOrchestratorSeatMaterialization } = await import("@/lib/orchestrator/seats");
      f.command.spawn = async (_body, _autonomous, admission) => {
        admission?.assertAccount?.(f.b.id);
        (await admission?.prepareAccount?.(f.b.id))?.();
        return { status: 202, body: { ok: true, accepted: true, launched: false, state: "accepted",
          conversationId: f.successor.id, launchId: "launch_auth_baseline_pending" } };
      };
      await f.check();
      const transcript = f.registry.conversation(f.successor.id)!.generations.at(-1)!.path;
      const at = "2026-10-08T00:08:00Z";
      fs.writeFileSync(transcript, JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: "seat tick" } }) + "\n"
        + JSON.stringify({ type: "assistant", timestamp: at, error: "authentication_failed", isApiErrorMessage: true,
          message: { model: "<synthetic>", content: [{ type: "text", text: ERROR_TEXT }] } }) + "\n");
      const credentials = path.join(f.b.home, ".credentials.json");
      fs.writeFileSync(credentials, '{"repaired":true}', { mode: 0o600 });
      const login = new Date("2026-10-08T00:09:00Z"); fs.utimesSync(credentials, login, login);
      confirmOrchestratorSeatMaterialization({ project: PROJECT, clientRequestId: f.seat().intent.clientRequestId,
        conversationId: f.successor.id, path: transcript });
      f.capacity(f.a.id, 100);
      await f.check(); await f.check();
      expect(f.row().authIncident).toBeUndefined();
      expect(f.row().authRecoveredThrough).toBe(Date.parse(at));
      expect(f.reports()).toHaveLength(1);
      expect(f.rig.sent.length).toBeGreaterThan(0);
      expect((await f.restartAuthentication()).authIncident).toBeUndefined();
    });
  });

  test("a provisional authentication rotation keeps the incident through rollback and restart", async () => {
    for (const repair of ["login", "normal-turn"]) await authFixture(true, async (f) => {
      const { reconcileActiveOrchestratorSeat } = await import("@/lib/orchestrator/seatCommand");
      const pending = "conversation_auth_pending";
      f.command.spawn = async () => ({ status: 202, body: { ok: true, accepted: true, launched: false, state: "accepted", conversationId: pending, launchId: "launch_auth_pending" } });
      f.command.launchSettlement = () => ({ kind: "unknown" });
      await f.check();
      expect(f.seat().conversationId).toBe(pending);
      expect(f.row().authIncident?.rotation.state).toBe("rotated");
      expect(f.cards()[0]?.status).toBe("inbox");
      expect((await f.restartAuthentication()).authIncident?.conversationId).toBe(f.original.conversationId!);
      f.command.launchSettlement = () => ({ kind: "failed", error: "fixture asynchronous launch failure" });
      expect(reconcileActiveOrchestratorSeat(PROJECT, f.command)?.restored?.conversationId).toBe(f.original.conversationId);
      expect(f.seat().seatEpoch).not.toBe(f.original.seatEpoch);
      await f.check(); await f.check();
      expect(f.rig.sent).toHaveLength(0);
      expect(f.row().authIncident?.rotation.state).toBe("refused");
      expect(f.row().authIncident?.seatEpoch).toBe(f.seat().seatEpoch);
      expect(f.cards()[0]?.status).toBe("inbox");
      expect(f.cards()[0]?.text).toContain("fixture asynchronous launch failure");
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      expect((await f.restartAuthentication()).authIncident?.rotation.state).toBe("refused");
      if (repair === "login") {
        fs.writeFileSync(path.join(f.a.home, ".credentials.json"), "{\"repaired\":true}");
        fs.utimesSync(path.join(f.a.home, ".credentials.json"), new Date(AUTH_TS + MINUTE), new Date(AUTH_TS + MINUTE));
      } else f.appendTurn(null, new Date(AUTH_TS + MINUTE).toISOString());
      await f.check();
      expect(f.row().authIncident).toBeUndefined(); expect(f.cards()[0]?.status).toBe("done");
      expect(f.rig.sent).toHaveLength(1);
    });
  });

  test("a lost rotation-outcome write cannot clear authentication when the accepted successor rolls back", async () => {
    for (const trimHistory of [false, true]) await authFixture(true, async (f) => {
      const { reconcileActiveOrchestratorSeat } = await import("@/lib/orchestrator/seatCommand");
      f.command.spawn = async () => ({ status: 202, body: { ok: true, accepted: true, state: "accepted", conversationId: "conversation_auth_pending", launchId: "launch_auth_pending" } });
      let lost = false;
      f.rig.deps.writeState = (project, row) => {
        if (!lost && row.authIncident?.rotation.state === "rotated") { lost = true; throw new Error("fixture lost rotation-outcome write"); }
        writeSeatTickState(project, row);
      };
      await f.check();
      expect(lost).toBe(true); expect(f.row().authIncident?.rotation.state).toBe("pending");
      f.command.launchSettlement = () => ({ kind: "failed", error: "fixture asynchronous launch failure" });
      expect(reconcileActiveOrchestratorSeat(PROJECT, f.command)?.restored?.conversationId).toBe(f.original.conversationId);
      if (trimHistory) {
        const { beginOrchestratorSeatIntent, failOrchestratorSeatIntent, ORCHESTRATOR_SEAT_HISTORY_CAP } = await import("@/lib/orchestrator/seats");
        for (let index = 0; index < ORCHESTRATOR_SEAT_HISTORY_CAP; index++) {
          const clientRequestId = `unrelated_auth_failure_${index}`;
          beginOrchestratorSeatIntent({ project: "auth-unrelated-fixture", mandate: "Fixture mandate", engine: "claude", clientRequestId, mode: "spawn" });
          failOrchestratorSeatIntent("auth-unrelated-fixture", clientRequestId, "fixture unrelated terminal failure");
        }
      }
      await f.check(); await f.check();
      expect(f.rig.sent).toHaveLength(0); expect(f.row().authIncident?.rotation.state).toBe("refused");
      expect(f.row().authIncident?.seatEpoch).toBe(f.seat().seatEpoch);
      expect(f.reports()).toHaveLength(1); expect(f.reports()[0]?.class).toBe("blocked");
      expect(f.cards()[0]?.status).toBe("inbox"); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
      expect((await f.restartAuthentication()).authIncident?.rotation.state).toBe("refused");
    });
  });

  test("a provisional authentication rotation resolves only after successor materialization", async () => {
    await authFixture(true, async (f) => {
      const { reconcileActiveOrchestratorSeat } = await import("@/lib/orchestrator/seatCommand");
      const resolved = f.command.resolvedConversation;
      f.command.resolvedConversation = (id) => id === f.successor.id ? null : resolved(id);
      f.command.spawn = async () => ({ status: 202, body: { ok: true, accepted: true, state: "accepted", conversationId: f.successor.id, launchId: "launch_auth_pending" } });
      await f.check();
      expect(f.row().authIncident?.rotation.state).toBe("rotated"); expect(f.cards()[0]?.status).toBe("inbox");
      f.command.resolvedConversation = resolved;
      reconcileActiveOrchestratorSeat(PROJECT, f.command);
      await f.check();
      expect(f.row().authIncident).toBeUndefined(); expect(f.cards()[0]?.status).toBe("done");
      expect(f.reports()).toHaveLength(1); expect(f.transport.callsOf("sendMessage")).toHaveLength(1);
    });
  });

  test("a concurrent manual designation fences automatic rotation before it can replace the new seat", async () => {
    await authFixture(true, async (f) => {
      const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
      const { executeOrchestratorRotation } = await import("@/lib/orchestrator/seatCommand");
      f.rig.deps.seatAuth!.rotate = async (body) => {
        beginOrchestratorSeatIntent({ project: PROJECT, mandate: "Manual handoff", engine: "claude", model: "opus", clientRequestId: "manual_auth_fixture", mode: "spawn", now: "2026-10-08T00:06:00Z" });
        completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "manual_auth_fixture", conversationId: f.successor.id, path: f.transcript, now: "2026-10-08T00:06:00Z" });
        const result = await executeOrchestratorRotation(body, f.command, null);
        expect(result.status).toBe(409); expect(result.body.code).toBe("incumbent_changed"); return result;
      };
      await f.check(); expect(f.spawns).toHaveLength(0); expect(f.row().authIncident).toBeUndefined(); expect(f.reports()).toHaveLength(0); expect(f.transport.callsOf("sendMessage")).toHaveLength(0);
    });
  });
});
