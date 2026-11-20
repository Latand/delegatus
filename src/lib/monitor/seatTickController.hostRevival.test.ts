import { expect, test, fs, path, createHash, SANDBOX, harness, PROJECT, CONVERSATION, NOW, MINUTE, RECENT, DEFAULT_SEAT_TICK_POLICY,
  runSeatTickCheck, reconcileSeatTick, startSeatTick, stopSeatTick, readSeatTickState, writeSeatTickState, emptySeatTickState,
  AgentRegistry, setAgentRegistryForTests, emptyLaunchProfile, sessionKeyFromTranscript, defaultSeatTickSettings,
  childFixture, childRig, refuseBeforeReservation } from "./seatTickController.fixture";
import { seatHostRecoveryKey, seatHostRevivalBackoffMs, SEAT_HOST_REVIVAL_LOST_BOUND, SEAT_HOST_REVIVAL_SETTLE_MS } from "./seatHostRecovery";
import type { AgentLivenessRecord, RuntimeHostClient } from "./seatTickController.fixture";
import type { SeatHostRevival } from "./seatHostRecovery";
import type { HostExitRecord } from "@/lib/runtime/hostExit";

/* A designated seat whose host is gone comes back from the seat tick itself,
   with no message to it. The shape is the one a release handover leaves: an
   idle seat whose stdin closed, so its host exited with code 0 and nobody
   recorded a stop. */

const EXITED_CLEANLY: HostExitRecord = {
  process: { pid: 2_000_000_001, startIdentity: "severed-host" },
  stop: null,
  exit: { at: new Date(NOW - 20 * MINUTE).toISOString(), code: 0, signal: null },
};

function severedSeat(exit: HostExitRecord = EXITED_CLEANLY): Partial<AgentLivenessRecord> {
  return { conversationId: CONVERSATION, lifecycle: "gone", reason: "host_gone_turn_settled", turnState: "idle",
    host: { state: "gone", kind: "structured", pid: null }, hostExit: null, previousHostExit: exit };
}

/** A seat tick rig over a state file of the test's own, so a second rig over
    the same file is the next process reading what the first one wrote. */
function revivalRig(options: { now?: number; stateFile?: string; exit?: HostExitRecord; seat?: null } = {}) {
  const stateFile = options.stateFile ?? path.join(fs.mkdtempSync(path.join(SANDBOX, "host-revival-")), "seat-tick.json");
  if (!options.stateFile) writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...RECENT,
    lastProposalAt: new Date(NOW - MINUTE).toISOString() }, stateFile);
  let alive = false;
  const rig = harness({ stateFile, now: options.now ?? NOW, seatActivity: severedSeat(options.exit),
    ...(options.seat === null ? { seat: null } : {}) });
  const liveness = rig.deps.sources!.liveness;
  rig.deps.sources!.liveness = async request => alive && request.conversationId === CONVERSATION
    ? [{ conversationId: CONVERSATION, lifecycle: "running", reason: "host_alive_turn_idle", turnState: "idle",
      host: { state: "alive", kind: "structured", pid: process.pid } } as AgentLivenessRecord]
    : liveness(request);
  const revivals: Parameters<SeatHostRevival>[0][] = [];
  let answer: () => ReturnType<SeatHostRevival> = async () => {
    alive = true;
    return { target: null, path: "", conversationId: CONVERSATION as never, spawned: true };
  };
  rig.deps.sources!.reviveSeatHost = async request => { revivals.push(request); return answer(); };
  return { rig, stateFile, revivals, row: () => readSeatTickState(PROJECT, stateFile), hostBack: () => { alive = true; },
    fail: (error: Error) => { answer = async () => { throw error; }; },
    succeed: () => { answer = async () => { alive = true; return { target: null, path: "", conversationId: CONVERSATION as never, spawned: true }; }; } };
}

test("an idle designated seat whose host exited cleanly across a handover is revived by the next check without a message", async () => {
  const { rig, revivals, row } = revivalRig();
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(revivals).toHaveLength(1);
  expect(revivals[0]).toMatchObject({ conversationId: CONVERSATION, origin: { kind: "agent", role: "seat-tick" } });
  // Host-only recovery: nothing was sent, so no model turn was started.
  expect(rig.sent).toEqual([]);
  expect(row().hostRecovery).toMatchObject({ conversationId: CONVERSATION, seatEpoch: 7, state: "revived", attempts: 1 });
  expect(record?.detail).toContain("seat host revival: revived");
  expect(rig.cards.filter(({ card }) => card.state === "open")).toEqual([]);
  // The revived host is live: the next check has nothing to revive.
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(revivals).toHaveLength(1);
});

test("the seat tick's first check at boot revives the severed seat within the startup pass", async () => {
  const { rig, revivals, row } = revivalRig();
  let swept!: () => void;
  const sweep = new Promise<void>(resolve => { swept = resolve; });
  const intervals: number[] = [];
  stopSeatTick();
  try {
    expect(startSeatTick({
      policy: DEFAULT_SEAT_TICK_POLICY, recordSuccessions: () => [], handoffHeld: () => false, drainHeld: () => false,
      // No interval elapses in this test: only the boot pass can run.
      scheduleInterval: (_callback, delayMs) => { intervals.push(delayMs); return { unref() {} } as never; },
      sweep: async () => { try { await reconcileSeatTick(rig.deps); } finally { swept(); } },
    })).toBe(true);
    await sweep;
  } finally { stopSeatTick(); }
  expect(intervals).toEqual([DEFAULT_SEAT_TICK_POLICY.checkIntervalMs / 2]);
  expect(revivals.map(request => request.conversationId)).toEqual([CONVERSATION]);
  expect(rig.sent).toEqual([]);
  expect(row().hostRecovery?.state).toBe("revived");
});

test.each(["kill-action", "structured-host-kill", "/api/proc", "structured-reconfigure"])(
  "a seat whose host was stopped on purpose (%s) is never revived", async stopPath => {
    const exit: HostExitRecord = { ...EXITED_CLEANLY, stop: { path: stopPath, operationId: "operator-stop", signal: "SIGTERM", at: new Date(NOW - 21 * MINUTE).toISOString() },
      exit: { at: new Date(NOW - 20 * MINUTE).toISOString(), code: null, signal: "SIGTERM" } };
    const { rig, revivals, row } = revivalRig({ exit });
    const record = await runSeatTickCheck(PROJECT, rig.deps);
    expect(revivals).toEqual([]);
    expect(row().hostRecovery).toBeFalsy();
    expect(record?.detail).toContain("stopped deliberately");
  });

test("the release handover's own cut is a severance, and its seat is revived", async () => {
  const exit: HostExitRecord = { ...EXITED_CLEANLY, stop: { path: "deploy-cut", operationId: "boundary", signal: "SIGTERM", at: new Date(NOW - 21 * MINUTE).toISOString() } };
  const { rig, revivals } = revivalRig({ exit });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(revivals).toHaveLength(1);
});

/* Losses nobody chose: a host that cleaned itself up after its stream or
   protocol failed, and an orphan of the outgoing release that startup
   demotion could not adopt and reaped. */
test.each(["claude-host-fault", "codex-host-fault", "structured-orphan-stop"])("a host lost to %s is a severance, and its seat is revived", async stopPath => {
  const exit: HostExitRecord = { ...EXITED_CLEANLY, stop: { path: stopPath, operationId: "lost", signal: "SIGTERM", at: new Date(NOW - 21 * MINUTE).toISOString() } };
  const { rig, revivals, row } = revivalRig({ exit });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(revivals).toHaveLength(1);
  expect(row().hostRecovery).toMatchObject({ state: "revived", attempts: 1 });
  expect(record?.detail).toContain("seat host revival: revived");
});

test("a check still running in a release that lost traffic revives nothing", async () => {
  const exit: HostExitRecord = { ...EXITED_CLEANLY, stop: { path: "deploy-cut", operationId: "boundary", signal: "SIGTERM", at: new Date(NOW - 21 * MINUTE).toISOString() } };
  const { rig, revivals, row } = revivalRig({ exit });
  rig.deps.ownsTraffic = () => false;
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(revivals).toEqual([]);
  expect(row().hostRecovery).toBeFalsy();
  expect(rig.cards.filter(({ card }) => card.kind === "host-recovery")).toEqual([]);
  expect(record?.detail).toContain("seat host revival deferred: viewer-release-replaced");
});

test("traffic lost while the revival is admitted refuses it at the recovery's own guard", async () => {
  const { rig, revivals, row } = revivalRig();
  let owns = true;
  rig.deps.ownsTraffic = async () => owns;
  const revive = rig.deps.sources!.reviveSeatHost!;
  rig.deps.sources!.reviveSeatHost = async (request, dependencies) => {
    // The release is demoted after the pre-check; the recovery's next guard sees it.
    owns = false;
    request.admissionGuard?.();
    // Every pending microtask, the asynchronous ownership answer included, settles first.
    await new Promise(resolve => setTimeout(resolve, 0));
    request.admissionGuard?.();
    return revive(request, dependencies);
  };
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(revivals).toEqual([]);
  expect(row().hostRecovery).toBeFalsy();
  expect(rig.cards.filter(({ card }) => card.kind === "host-recovery")).toEqual([]);
  expect(record?.detail).toContain("seat host revival deferred: viewer-release-replaced");
});

async function failedOnce() {
  const first = revivalRig();
  first.fail(new Error("No conversation found with session ID"));
  await runSeatTickCheck(PROJECT, first.rig.deps);
  const recovery = first.row().hostRecovery!;
  expect(recovery).toMatchObject({ state: "unrevived", told: true });
  expect(first.rig.cards).toContainEqual({ project: PROJECT, card: expect.objectContaining({
    ref: "seat-host-recovery", instance: recovery.id, state: "open" }) });
  return { first, recovery };
}

test("a failed revival's card closes when the host came back by another path during the backoff", async () => {
  const { first, recovery } = await failedOnce();
  // A message to the seat revived it before the tick's next attempt was due.
  const later = revivalRig({ stateFile: first.stateFile, now: NOW + DEFAULT_SEAT_TICK_POLICY.checkIntervalMs / 2 });
  later.hostBack();
  const record = await runSeatTickCheck(PROJECT, later.rig.deps);
  expect(later.revivals).toEqual([]);
  expect(later.rig.cards).toContainEqual({ project: PROJECT, card: expect.objectContaining({
    ref: "seat-host-recovery", instance: recovery.id, state: "resolved" }) });
  expect(later.row().hostRecovery).toMatchObject({ id: recovery.id, state: "revived", told: true });
  expect(record?.detail).toContain("seat host revival settled: the host came back by another path");
  expect(later.row().hostRecovery?.retryAt).toBeUndefined();
  // Settled: the next check neither closes it again nor revives anything.
  const after = revivalRig({ stateFile: first.stateFile, now: NOW + DEFAULT_SEAT_TICK_POLICY.checkIntervalMs * 3 / 4 });
  after.hostBack();
  await runSeatTickCheck(PROJECT, after.rig.deps);
  expect(after.revivals).toEqual([]);
  expect(after.rig.cards.filter(({ card }) => card.kind === "host-recovery")).toEqual([]);
  // Lost again before the failed attempt's old bound: revived at once.
  const lostAgain = revivalRig({ stateFile: first.stateFile, now: NOW + DEFAULT_SEAT_TICK_POLICY.checkIntervalMs * 7 / 8 });
  await runSeatTickCheck(PROJECT, lostAgain.rig.deps);
  expect(lostAgain.revivals).toHaveLength(1);
  expect(lostAgain.row().hostRecovery).toMatchObject({ state: "revived", attempts: 2 });
});

test("a failed revival's card closes when the seat was rotated away", async () => {
  const { first, recovery } = await failedOnce();
  const later = revivalRig({ stateFile: first.stateFile, now: NOW + 2 * DEFAULT_SEAT_TICK_POLICY.checkIntervalMs });
  later.rig.seat = { conversationId: ["conversation", "a1b2c3d4e5f60718"].join("_"), seatEpoch: 8, path: null };
  const record = await runSeatTickCheck(PROJECT, later.rig.deps);
  expect(later.revivals).toEqual([]);
  expect(later.rig.cards).toContainEqual({ project: PROJECT, card: expect.objectContaining({
    ref: "seat-host-recovery", instance: recovery.id, state: "resolved" }) });
  expect(later.row().hostRecovery).toMatchObject({ id: recovery.id, state: "superseded", told: true });
  expect(record?.detail).toContain("seat host revival settled: the seat changed");
});

test("a failed revival's card closes when the project was dedesignated", async () => {
  const { first, recovery } = await failedOnce();
  const later = revivalRig({ stateFile: first.stateFile, now: NOW + 2 * DEFAULT_SEAT_TICK_POLICY.checkIntervalMs, seat: null });
  await runSeatTickCheck(PROJECT, later.rig.deps);
  expect(later.revivals).toEqual([]);
  expect(later.rig.cards).toContainEqual({ project: PROJECT, card: expect.objectContaining({
    ref: "seat-host-recovery", instance: recovery.id, state: "resolved" }) });
  expect(later.row().hostRecovery).toMatchObject({ id: recovery.id, state: "superseded" });
});

test("a failed revival's card stays open while the host is still gone and the next attempt is not due", async () => {
  const { first, recovery } = await failedOnce();
  const later = revivalRig({ stateFile: first.stateFile, now: NOW + DEFAULT_SEAT_TICK_POLICY.checkIntervalMs / 2 });
  await runSeatTickCheck(PROJECT, later.rig.deps);
  expect(later.rig.cards.filter(({ card }) => card.kind === "host-recovery" && card.state === "resolved")).toEqual([]);
  expect(later.row().hostRecovery).toMatchObject({ id: recovery.id, state: "unrevived" });
});

test("a failed revival's card closes when a delivered wake re-hosts the seat during the backoff", async () => {
  const fixture = childFixture("unrevived-then-wake");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "owed worker", turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture, { realWakeState: true, deliverWith: refuseBeforeReservation(503) }).deps);
  // The tick's own revival failed earlier and its next attempt is not yet due.
  const unrevived = { id: seatHostRecoveryKey(fixture.project, fixture.seat.seatEpoch, `host-loss:${fixture.seat.conversationId}`),
    conversationId: fixture.seat.conversationId, seatEpoch: fixture.seat.seatEpoch, at: new Date(fixture.now).toISOString(),
    state: "unrevived" as const, detail: "No conversation found with session ID", told: true, attempts: 1,
    retryAt: new Date(fixture.now + 60 * MINUTE).toISOString() };
  writeSeatTickState(fixture.project, { ...fixture.row(), hostRecovery: unrevived }, fixture.stateFile);
  const recovered = childRig(fixture, { realWakeState: true, now: fixture.now + 5 * MINUTE,
    seatActivity: { conversationId: fixture.seat.conversationId, host: { state: "gone", kind: "structured", pid: null }, reason: "host_gone_turn_settled", lifecycle: "gone" },
    deliverWith: async () => ({ ok: true, target: null, outcome: "delivered", structured: true, spawned: true }) });
  recovered.deps.mcpHealth = () => ({ status: "dead", detail: "old MCP absent" });
  await runSeatTickCheck(fixture.project, recovered.deps);
  expect(recovered.sent).toHaveLength(1);
  expect(fixture.row().hostRecovery).toMatchObject({ state: "revived" });
  expect(recovered.cards).toContainEqual({ project: fixture.project, card: expect.objectContaining({
    ref: "seat-host-recovery", instance: unrevived.id, state: "resolved" }) });
});

test("a retired seat is never revived", async () => {
  const { rig, revivals } = revivalRig({ seat: null });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(revivals).toEqual([]);
});

test("a seat rotated away is never revived: only the active seat's host is read", async () => {
  const { rig, revivals } = revivalRig();
  rig.seat = { conversationId: ["conversation", "a1b2c3d4e5f60718"].join("_"), seatEpoch: 8, path: null };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(revivals).toEqual([]);
});

test("a failed revival is carded, backs off across a restart, and closes its card when a later attempt succeeds", async () => {
  const first = revivalRig();
  first.fail(new Error("No conversation found with session ID"));
  const failed = await runSeatTickCheck(PROJECT, first.rig.deps);
  expect(first.revivals).toHaveLength(1);
  const recovery = first.row().hostRecovery!;
  expect(recovery).toMatchObject({ state: "unrevived", attempts: 1, told: true,
    retryAt: new Date(NOW + DEFAULT_SEAT_TICK_POLICY.checkIntervalMs).toISOString() });
  expect(failed?.detail).toContain("seat host revival: unrevived (attempt 1)");
  expect(first.rig.cards).toContainEqual({ project: PROJECT, card: expect.objectContaining({
    ref: "seat-host-recovery", kind: "host-recovery", state: "open", instance: recovery.id }) });

  // The same process checking again before the bound attempts nothing.
  await runSeatTickCheck(PROJECT, first.rig.deps);
  expect(first.revivals).toHaveLength(1);

  // A restarted process reads the bound from durable state, not from memory.
  const early = revivalRig({ stateFile: first.stateFile, now: NOW + DEFAULT_SEAT_TICK_POLICY.checkIntervalMs - 1 });
  const held = await runSeatTickCheck(PROJECT, early.rig.deps);
  expect(early.revivals).toEqual([]);
  expect(held?.detail).toContain(`next attempt ${recovery.retryAt}`);

  const second = revivalRig({ stateFile: first.stateFile, now: NOW + DEFAULT_SEAT_TICK_POLICY.checkIntervalMs });
  second.fail(new Error("No conversation found with session ID"));
  await runSeatTickCheck(PROJECT, second.rig.deps);
  expect(second.revivals).toHaveLength(1);
  expect(second.row().hostRecovery).toMatchObject({ state: "unrevived", attempts: 2,
    retryAt: new Date(NOW + 3 * DEFAULT_SEAT_TICK_POLICY.checkIntervalMs).toISOString() });

  const third = revivalRig({ stateFile: first.stateFile, now: NOW + 3 * DEFAULT_SEAT_TICK_POLICY.checkIntervalMs });
  await runSeatTickCheck(PROJECT, third.rig.deps);
  expect(third.revivals).toHaveLength(1);
  expect(third.row().hostRecovery).toMatchObject({ state: "revived", attempts: 3 });
  expect(third.rig.cards).toContainEqual({ project: PROJECT, card: expect.objectContaining({
    ref: "seat-host-recovery", instance: recovery.id, state: "resolved" }) });
});

/* A host that faults soon after every start: each check finds the host it
   revived gone again. Every rig is a fresh process over the same state file. */
async function flapping(checks: number, exit: HostExitRecord) {
  const first = revivalRig({ exit });
  await runSeatTickCheck(PROJECT, first.rig.deps);
  const rows = [first.row().hostRecovery!];
  const cards = [...first.rig.cards];
  for (let check = 1; check < checks; check++) {
    const next = revivalRig({ stateFile: first.stateFile, now: Date.parse(rows.at(-1)!.retryAt!), exit });
    await runSeatTickCheck(PROJECT, next.rig.deps);
    expect(next.revivals).toHaveLength(1);
    rows.push(next.row().hostRecovery!);
    cards.push(...next.rig.cards);
  }
  return { stateFile: first.stateFile, rows, cards };
}

test("a host lost before each next check keeps one episode: the backoff reaches the hour cap and the card opens at the bound", async () => {
  const exit: HostExitRecord = { ...EXITED_CLEANLY, stop: { path: "claude-host-fault", operationId: "lost", signal: "SIGTERM", at: new Date(NOW - 21 * MINUTE).toISOString() } };
  const checks = 9;
  const { rows, cards } = await flapping(checks, exit);
  const interval = DEFAULT_SEAT_TICK_POLICY.checkIntervalMs;
  // Never reset: attempts climb by one per check, and so does the lost count.
  expect(rows.map(row => row.attempts)).toEqual(Array.from({ length: checks }, (_, index) => index + 1));
  expect(rows.map(row => row.lost ?? 0)).toEqual(Array.from({ length: checks }, (_, index) => index));
  expect(rows.map(row => Date.parse(row.retryAt!) - Date.parse(row.at)))
    .toEqual(rows.map(row => seatHostRevivalBackoffMs(row.attempts!, interval)));
  expect(Date.parse(rows.at(-1)!.retryAt!) - Date.parse(rows.at(-1)!.at)).toBe(60 * MINUTE);
  expect(rows.every(row => !row.confirmedAt)).toBe(true);
  // The bound: the revival after the third lost one is unstable and carded.
  expect(rows.map(row => row.state)).toEqual(Array.from({ length: checks },
    (_, index) => index < SEAT_HOST_REVIVAL_LOST_BOUND ? "revived" : "unstable"));
  const instance = rows[0].id;
  const recoveryCards = cards.filter(({ card }) => card.kind === "host-recovery");
  const firstOpen = recoveryCards.findIndex(({ card }) => card.state === "open");
  expect(recoveryCards[firstOpen]).toEqual({ project: PROJECT, card: expect.objectContaining({ ref: "seat-host-recovery", instance }) });
  expect(recoveryCards[firstOpen].card.record).toContain(": unstable; ");
  // Once open it stays open while the host keeps getting lost.
  expect(recoveryCards.slice(firstOpen).filter(({ card }) => card.ref === "seat-host-recovery" && card.state === "resolved")).toEqual([]);
  expect(rows.at(-1)!.detail).toContain(`lost again after each of ${checks - 1} revivals`);
});

test("an unstable revival's card closes only once a check confirms its host alive a settle window later, which ends the episode", async () => {
  const { stateFile, rows } = await flapping(SEAT_HOST_REVIVAL_LOST_BOUND + 1, EXITED_CLEANLY);
  const unstable = rows.at(-1)!;
  expect(unstable.state).toBe("unstable");
  // Alive, but not yet for the settle window: the card stays open.
  const early = revivalRig({ stateFile, now: Date.parse(unstable.at) + SEAT_HOST_REVIVAL_SETTLE_MS - 1 });
  early.hostBack();
  await runSeatTickCheck(PROJECT, early.rig.deps);
  expect(early.revivals).toEqual([]);
  expect(early.rig.cards.filter(({ card }) => card.kind === "host-recovery" && card.state === "resolved")).toEqual([]);
  expect(early.row().hostRecovery).toMatchObject({ state: "unstable" });

  const confirmedAt = Date.parse(unstable.at) + SEAT_HOST_REVIVAL_SETTLE_MS;
  const held = revivalRig({ stateFile, now: confirmedAt });
  held.hostBack();
  const record = await runSeatTickCheck(PROJECT, held.rig.deps);
  expect(held.rig.cards).toContainEqual({ project: PROJECT, card: expect.objectContaining({
    ref: "seat-host-recovery", instance: unstable.id, state: "resolved" }) });
  expect(held.row().hostRecovery).toMatchObject({ state: "revived", confirmedAt: new Date(confirmedAt).toISOString() });
  expect(held.row().hostRecovery?.retryAt).toBeUndefined();
  expect(record?.detail).toContain("seat host revival settled: the revived host stayed alive");

  // A later loss starts a new episode at once.
  const lostLater = revivalRig({ stateFile, now: confirmedAt + MINUTE });
  await runSeatTickCheck(PROJECT, lostLater.rig.deps);
  expect(lostLater.revivals).toHaveLength(1);
  expect(lostLater.row().hostRecovery).toMatchObject({ state: "revived", attempts: 1 });
  expect(lostLater.row().hostRecovery?.lost).toBeUndefined();
});

test("a revived host confirmed alive after the settle window ends its episode, and one seen alive earlier does not", async () => {
  const { rig, row, stateFile } = revivalRig();
  await runSeatTickCheck(PROJECT, rig.deps);
  const revived = row().hostRecovery!;
  expect(revived).toMatchObject({ state: "revived", attempts: 1 });
  // Seen alive within the window: not confirmed, so a loss continues the episode.
  const seen = revivalRig({ stateFile, now: Date.parse(revived.at) + SEAT_HOST_REVIVAL_SETTLE_MS - 1 });
  seen.hostBack();
  await runSeatTickCheck(PROJECT, seen.rig.deps);
  expect(seen.row().hostRecovery?.confirmedAt).toBeUndefined();
  const confirmedAt = Date.parse(revived.at) + SEAT_HOST_REVIVAL_SETTLE_MS;
  const confirm = revivalRig({ stateFile, now: confirmedAt });
  confirm.hostBack();
  await runSeatTickCheck(PROJECT, confirm.rig.deps);
  expect(confirm.revivals).toEqual([]);
  expect(confirm.row().hostRecovery).toMatchObject({ state: "revived", attempts: 1, confirmedAt: new Date(confirmedAt).toISOString() });
  expect(confirm.rig.cards.filter(({ card }) => card.kind === "host-recovery")).toEqual([]);
  const lost = revivalRig({ stateFile, now: confirmedAt + MINUTE });
  await runSeatTickCheck(PROJECT, lost.rig.deps);
  expect(lost.row().hostRecovery).toMatchObject({ state: "revived", attempts: 1 });
});

test("an ownership race during revival defers to the next check without a failure card", async () => {
  const { rig, revivals, row, fail } = revivalRig();
  const contended = new Error("structured recovery operation is superseded");
  contended.name = "StructuredRecoverySupersededError";
  fail(contended);
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(revivals).toHaveLength(1);
  expect(row().hostRecovery).toBeFalsy();
  expect(rig.cards.filter(({ card }) => card.kind === "host-recovery")).toEqual([]);
  expect(record?.detail).toContain("seat host revival deferred: StructuredRecoverySupersededError");
});

/* Both engines through the real shared recovery: a dead registry row, a
   reservation, a successor claim, and a spawn that carries no prompt. */
test.each(["claude", "codex"] as const)("a severed %s seat is re-hosted by the shared recovery with an empty prompt", async engine => {
  const { recoverDeadStructuredConversation } = await import("@/lib/runtime/structuredRecovery");
  const { spawnStructuredConversation } = await import("@/lib/runtime/structuredSpawn");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const dir = fs.mkdtempSync(path.join(SANDBOX, `revival-${engine}-`));
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(dir, "agent-registry.json"), () => false, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  // A fixed session id in UUID shape, derived rather than written out.
  const digest = createHash("sha256").update(`severed-${engine}-seat`).digest("hex");
  const sessionId = [digest.slice(0, 8), digest.slice(8, 12), `4${digest.slice(13, 16)}`, `8${digest.slice(17, 20)}`, digest.slice(20, 32)].join("-");
  const seatPath = path.join(dir, engine === "codex" ? `rollout-2026-08-28T11-00-00-${sessionId}.jsonl` : `${sessionId}.jsonl`);
  fs.writeFileSync(seatPath, `${JSON.stringify({ type: "user", message: { role: "user", content: "fixture prompt" } })}\n`);
  const conversation = registry.ensureConversation(engine, seatPath, null);
  const key = sessionKeyFromTranscript(engine, seatPath)!;
  const launchProfile = emptyLaunchProfile({ cwd, title: "Designated orchestrator" });
  const entry = { key, artifactPath: seatPath, cwd, accountId: null, launchProfile, status: "dead" as const, host: null,
    structuredHost: null, claimEpoch: 1, claimOwner: null, pendingAction: null };
  const old = registry.beginSpawnRequest({ engine, cwd, transport: "structured", conversationId: conversation.id,
    expectedArtifactPath: seatPath, launchProfile, spawnCapabilityDigest: "a".repeat(64) });
  registry.completeSpawn(old.receipt.launchId, entry);

  const stateFile = path.join(dir, "seat-tick.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...RECENT, lastProposalAt: new Date(NOW - MINUTE).toISOString() }, stateFile);
  const rig = harness({ stateFile, registry, seat: { conversationId: conversation.id, seatEpoch: 7, path: seatPath },
    settings: defaultSeatTickSettings(PROJECT),
    seatActivity: { ...severedSeat(), conversationId: conversation.id } });
  const prompts: string[] = [];
  const engines: string[] = [];
  rig.deps.sources!.reviveSeatHost = request => recoverDeadStructuredConversation(request, { registry,
    client: { command: async () => ({}), append: async () => ({}), transitionOperation: async () => ({}) } as unknown as RuntimeHostClient,
    transportAvailable: () => true, park: () => null, requestDeliveryDrain: () => {},
    resolveAccount: () => ({ engine, accountId: "default", kind: "legacy", home: dir, transcriptRoot: dir, env: { NODE_ENV: "test" } }) as never,
    spawn: async input => {
      prompts.push(input.prompt);
      engines.push(input.spec.engine);
      return spawnStructuredConversation(input, {
        startHost: async () => ({ identity: engine === "codex" ? { threadId: key.sessionId, path: seatPath } : { sessionId: key.sessionId },
          viewerMcpTransport: "stdio", release: async () => {},
          health: async () => ({ status: "idle", pid: null, processStartIdentity: null }) }) as never,
        bindHost: async (bound, claimedKey, _host, owner, epoch) => {
          bound.setStructuredHostClaimed(claimedKey, {
            kind: engine === "codex" ? "codex-app-server" : "claude-broker", endpoint: "stdio:revived", process: captureProcessIdentity(process.pid),
            eventCursor: 0, protocolVersion: "v1", writerClaimEpoch: epoch, activeTurnRef: null, pendingAttention: [], activeFlags: [],
          }, "idle", owner, epoch);
          return () => {};
        },
        publishHost: async (_key, _host, owns) => { expect(await owns!()).toBe(true); return async () => {}; },
      });
    } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(engines).toEqual([engine]);
  expect(prompts).toEqual([""]);
  expect(rig.sent).toEqual([]);
  expect(record?.detail).toContain("seat host revival: revived");
  const revived = registry.readOnlySnapshot().entries[`${engine}:${key.sessionId}`];
  expect(revived?.claimOwner).toBeTruthy();
  expect(revived?.structuredHost?.process?.pid).toBe(process.pid);
});


test("a persisted incoming delivery recovery owns a severed seat across controller replacement", async () => {
  const first = revivalRig();
  const at = new Date(NOW - MINUTE).toISOString();
  const pending = { id: seatHostRecoveryKey(PROJECT, 7, CONVERSATION), conversationId: CONVERSATION,
    seatEpoch: 7, at, state: "pending" as const, detail: "Incoming delivery recovery: cleanup", told: true,
    incoming: { since: at, episodeId: "fixture-incoming-episode", episodeAdmissionSeq: 2,
      phase: "cleanup" as const, attemptedAt: at, hostIdentity: "fixture-captured-host" } };
  writeSeatTickState(PROJECT, { ...first.row(), hostRecovery: pending }, first.stateFile);
  await runSeatTickCheck(PROJECT, first.rig.deps);
  expect(first.revivals).toEqual([]);
  expect(first.row().hostRecovery).toMatchObject(pending);
  const successor = revivalRig({ stateFile: first.stateFile, now: NOW + MINUTE });
  await runSeatTickCheck(PROJECT, successor.rig.deps);
  expect(successor.revivals).toEqual([]);
  expect(successor.row().hostRecovery).toMatchObject(pending);
});
