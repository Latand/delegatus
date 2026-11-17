import { expect, test, fs, path, createHash, SANDBOX, harness, PROJECT, CONVERSATION, NOW, MINUTE, RECENT, DEFAULT_SEAT_TICK_POLICY,
  runSeatTickCheck, reconcileSeatTick, startSeatTick, stopSeatTick, readSeatTickState, writeSeatTickState, emptySeatTickState,
  AgentRegistry, setAgentRegistryForTests, emptyLaunchProfile, sessionKeyFromTranscript, defaultSeatTickSettings } from "./seatTickController.fixture";
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
  return { rig, stateFile, revivals, row: () => readSeatTickState(PROJECT, stateFile),
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
