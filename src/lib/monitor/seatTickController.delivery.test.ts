import { expect, test, fs, path, SANDBOX, runSeatTickCheck, defaultSeatTickSettings, writeSeatTickState, readSeatTickState, emptySeatTickState, setAgentRegistryForTests, emptyLaunchProfile, PROJECT, CONVERSATION, NOW, MINUTE, harness, OVERDUE, RECENT, outstandingWake, OPEN_LANE, childFixture, childRig, ago, successorSeat, frozen, hostedSeat } from "./seatTickController.fixture";
import type { AgentLivenessRecord } from "./seatTickController.fixture";
import { setSystemTime } from "bun:test";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { cancelSeatQuotaOnControl } from "./seatQuotaRecovery";
import { wakeResponseEvidenceFromEvents, wakeResponseRecoveryKey, type SeatWakeResponse } from "./seatWakeResponse";
import { AgentRegistry } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";

// Terminal inbound failures survive fresh controller instances and enter the
// same recovery record that ordinary composer revival and lost-seat rotation use.
test.each(["direct", "partial", "admitted", "busy-revival", "gone-before-nudge"] as const)("consecutive incoming failures recover through nudge, cleanup and rotation (%s)", async mode => {
  const partial = mode === "partial";
  const { setSystemTime } = await import("bun:test");
  setSystemTime(new Date(NOW));
  const fixture = childFixture("incoming-recovery");
  const { journal, client, sessionId } = hostedSeat(fixture);
  const key = { engine: "claude" as const, sessionId };
  const entry = fixture.registry.hostEntry(key)!;
  // Settlement checks the recorded process identity while the admitted nudge is queued.
  const writer = mode === "admitted" ? captureProcessIdentity(process.pid) : { pid: 4100, startIdentity: "fixture-writer", bootEpoch: "fixture-boot" };
  fixture.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, process: writer } });
  fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: "idle", source: "assistant", terminalAt: new Date(NOW).toISOString() }, observedAt: new Date(NOW).toISOString() }]);
  const failure = (id: string) => {
    const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture notice", id);
    fixture.registry.recordDeliveryOutcome(held.id, "failed", "claude-native-broker/admission: native-evidence-uncertain", "lost");
  };
  failure("failed-wake"); failure("failed-finish-notice"); fixture.seed();
  let cleaned = 0, rotated = 0, admitted = false;
  const step = async (minutes: number) => {
    setSystemTime(new Date(NOW + minutes * MINUTE));
    const rig = childRig(fixture, { now: NOW + minutes * MINUTE, deliverWith: async message => {
        if (mode === "admitted" && !admitted) {
          admitted = true;
          const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, message.text, message.clientMessageId);
          fixture.registry.beginDeliveryAttempt(held.id, sessionId);
          journal.executeOperation({ kind: "send", operationId: held.command.operationId, idempotencyKey: message.clientMessageId!,
            conversationId: fixture.seat.conversationId, text: message.text, policy: "queue" });
          return { ok: true, outcome: "queued", target: "structured", structured: true, operationId: held.command.operationId };
        }
        return { ok: false, outcome: "failed", status: 409, admission: "refused", error: "fixture refused before reservation" };
      },
      seatActivity: { conversationId: fixture.seat.conversationId, verified: true, host: { state: "alive", kind: "structured", pid: writer.pid },
        turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle", activity: { state: "idle", check: null, idleForMs: minutes * MINUTE } } });
    rig.deps.sources!.registry = () => fixture.registry;
    rig.deps.seatRecovery = { client, cleanup: async (_id, guard, idle) => {
      expect(guard()).toBe(true); expect(await idle()).toBe(true); cleaned++;
      if (partial && cleaned === 1) {
        fixture.registry.upsert({ ...fixture.registry.hostEntry(key)!, structuredTerminationSurvivors: [{ pid: 4101, startIdentity: "fixture-child", bootEpoch: "fixture-boot" }] });
        return false;
      }
      const current = fixture.registry.hostEntry(key)!;
      expect(fixture.registry.terminateStructuredHost(key, current.structuredHost!.process!, current.structuredTerminationSurvivors ?? [])).toBe(true);
      return true;
    }, rotate: async (_request, _a, _b, options) => {
      expect(await options?.replacementHold?.()).toBeNull(); rotated++; return { status: 200, body: { ok: true } };
    } };
    if (cleaned || mode === "gone-before-nudge") rig.deps.sources!.liveness = async () => [{ conversationId: fixture.seat.conversationId,
      host: { state: "gone", kind: "none", pid: null }, turnState: "idle", reason: "host_gone_turn_settled", verified: true } as AgentLivenessRecord];
    return { rig, record: await runSeatTickCheck(fixture.project, rig.deps) };
  };
  try {
    const early = await step(14); expect(cleaned).toBe(0); expect(early.rig.sent).toHaveLength(0);
    const nudge = await step(15);
    expect(nudge.rig.sent).toHaveLength(mode === "gone-before-nudge" ? 0 : 1);
    if (mode === "gone-before-nudge") expect(nudge.record?.detail).toContain("host loss verified before nudge");
    if (mode === "admitted") {
      expect(fixture.row().hostRecovery?.incoming?.phase).toBe("nudge");
      const waiting = await step(16); expect(waiting.rig.sent).toHaveLength(0); expect(cleaned).toBe(0);
      expect(fixture.row().hostRecovery?.incoming?.phase).toBe("nudge");
      const settled = await step(26); expect(settled.rig.sent).toHaveLength(0);
    }
    expect(fixture.row().hostRecovery?.incoming?.phase).toBe("cleanup");
    expect(nudge.record?.detail).toContain("boundMs=900000");
    expect(nudge.rig.cards.some(({ card }) => card.kind === "host-recovery" && card.record?.includes("claude-native-broker"))).toBe(true);
    await step(mode === "admitted" ? 27 : 16); expect(cleaned).toBe(1);
    if (mode === "busy-revival") {
      fixture.registry.upsert({ ...fixture.registry.hostEntry(key)!, structuredHost: { ...entry.structuredHost!, activeTurnRef: "new-owner-turn",
        process: { pid: 4200, startIdentity: "fixture-new-writer", bootEpoch: "fixture-boot" } }, claimEpoch: 1 });
      const busy = await step(17); expect(busy.rig.sent).toHaveLength(0); expect(rotated).toBe(0);
      expect(busy.record?.detail).toContain("revival withheld"); return;
    }
    if (partial) {
      expect(fixture.row().hostRecovery?.incoming?.phase).toBe("cleanup");
      const resumed = await step(17); expect(cleaned).toBe(2);
      expect(resumed.record?.detail).toContain("cleanup confirmed");
    }
    expect(fixture.row().hostRecovery?.incoming?.phase).toBe("revive");
    const revived = await step(mode === "admitted" ? 28 : partial ? 18 : 17); expect(revived.rig.sent).toHaveLength(1); expect(rotated).toBe(1);
    await step(mode === "admitted" ? 29 : 19); expect(cleaned).toBe(partial ? 2 : 1); expect(rotated).toBe(1);
  } finally { journal.close(); fixture.registry.close(); setSystemTime(); }
});

test.each(["active", "permission", "background", "retry", "unknown", "uncertain", "success", "rotated", "disabled", "liveness-race", "operator-stop", "nudge-unknown", "nudge-read-race"] as const)(
  "incoming failure recovery holds a seat with %s ownership", async hold => {
    const { setSystemTime } = await import("bun:test"); setSystemTime(new Date(NOW));
    const fixture = childFixture(`incoming-held-${hold}`);
    const { journal, sessionId } = hostedSeat(fixture);
    const key = { engine: "claude" as const, sessionId };
    const entry = fixture.registry.hostEntry(key)!;
    fixture.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!,
      process: { pid: 4100, startIdentity: "fixture-writer", bootEpoch: "fixture-boot" },
      ...(hold === "active" ? { activeTurnRef: "real-turn" } : {}),
      ...(hold === "permission" ? { pendingAttention: ["real-question"] } : {}),
      ...(hold === "background" ? { activeFlags: ["background-work"] } : {}),
    } });
    fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: hold === "active" ? "busy" : "idle", source: "assistant", terminalAt: null }, observedAt: new Date(NOW).toISOString() }]);
    for (const id of ["incoming-one", "incoming-two"]) {
      const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture input", id);
      fixture.registry.recordDeliveryOutcome(held.id, "failed", "fixture terminal refusal", "lost");
    }
    if (hold === "uncertain" || hold === "success") {
      const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture later", "incoming-later");
      fixture.registry.recordDeliveryOutcome(held.id, hold === "success" ? "delivered" : "delivery-uncertain", null, hold === "success" ? "delivered" : "unverified");
    }
    fixture.seed({ lastWakeAt: new Date(NOW).toISOString() });
    const rig = childRig(fixture, { now: NOW + 20 * MINUTE,
      seatActivity: { conversationId: fixture.seat.conversationId, verified: hold !== "unknown", host: { state: "alive", kind: "structured", pid: 4100 },
        turnState: hold === "active" ? "busy" : "idle", lifecycle: hold === "active" ? "running" : "waiting",
        reason: hold === "retry" ? "provider_throttled" : "host_alive_turn_idle", activity: { state: "idle", check: null, idleForMs: 20 * MINUTE } } });
    if (hold === "rotated") rig.seat = successorSeat(fixture, 8);
    if (hold === "disabled") rig.deps.sources!.settings = () => ({ ...defaultSeatTickSettings(fixture.project), enabled: false });
    if (hold === "liveness-race") rig.deps.sources!.liveness = async () => {
      fixture.registry.upsert({ ...fixture.registry.hostEntry(key)!, structuredHost: { ...fixture.registry.hostEntry(key)!.structuredHost!, activeTurnRef: "new-turn" } });
      return [{ conversationId: fixture.seat.conversationId, verified: true, turnState: "idle",
        host: { state: "alive", kind: "structured", pid: 4100 }, reason: "host_alive_turn_idle",
        activity: { state: "idle", check: null, idleForMs: 20 * MINUTE } } as AgentLivenessRecord];
    };
    const readRace = async () => {
      fixture.registry.upsert({ ...fixture.registry.hostEntry(key)!, structuredHost: { ...fixture.registry.hostEntry(key)!.structuredHost!, activeTurnRef: "new-turn" } });
      return { kind: "absent" as const };
    };

    if (hold === "operator-stop") {
      const seats = await import("@/lib/orchestrator/seats");
      seats.beginOrchestratorSeatIntent({ project: fixture.project, mandate: "coordinate work", clientRequestId: "incoming-control", mode: "existing", now: new Date(NOW).toISOString() });
      seats.completeOrchestratorSeatIntent({ project: fixture.project, clientRequestId: "incoming-control", conversationId: fixture.seat.conversationId,
        path: fixture.seat.path, now: new Date(NOW).toISOString() });
      const active = seats.orchestratorSeatFor(fixture.project).active!;
      rig.seat = { ...fixture.seat, seatEpoch: active.seatEpoch };
      await (await import("./seatQuotaRecovery")).cancelSeatQuotaOnControl(fixture.seat.conversationId);
    }
    let effects = 0;
    rig.deps.seatRecovery = {
      ...(hold === "nudge-read-race" ? { delivery: readRace } : {}),
      ...(hold === "nudge-unknown" ? { delivery: async () => ({ kind: "unknown" as const }) } : {}),
      cleanup: async () => { effects++; return true; }, rotate: async () => { effects++; return { status: 200, body: {} }; } };
    rig.deps.deliver = async () => { effects++; return { ok: true, outcome: "delivered", target: "structured", structured: true }; };
    try {
      setSystemTime(new Date(NOW + 20 * MINUTE));
      await runSeatTickCheck(fixture.project, rig.deps);
      expect(effects).toBe(0);
    } finally { journal.close(); fixture.registry.close(); setSystemTime(); }
  });

test("incoming recovery cleans up the real idle broker that refuses native admission", async () => {
  const { admissionFixture } = await import("@/lib/runtime/fixtures/claudeNativeAdmission");
  const { claudeHostColumns } = await import("@/lib/runtime/registry");
  const fixture = childFixture("incoming-real-broker");
  const { journal, sessionId } = hostedSeat(fixture);
  const f = await admissionFixture(fixture.dir, sessionId);
  const host = await f.open(false, ledger => {
    const intent = ledger.recordNativeIntent.bind(ledger);
    ledger.recordNativeIntent = async (...args) => { await intent(...args); throw Object.assign(new Error("fixture append reply lost"), { code: "EIO" }); };
  });
  const key = { engine: "claude" as const, sessionId };
  setAgentRegistryForTests(fixture.registry);
  try {
    await expect(host.send({ id: "unconfirmed-intent", text: "fixture input" })).rejects.toThrow("persistence-uncertain");
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    expect(f.wire).toHaveLength(0);
    fixture.registry.upsert({ ...fixture.registry.hostEntry(key)!, structuredHost: claudeHostColumns(await host.health(), 0) });
    fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date().toISOString() }]);
    for (const id of ["own-wake", "finish-notice"]) {
      const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture notification", id);
      const result = await host.send({ id, text: "fixture notification" });
      expect(result.outcome).toBe("rejected");
      const refusal = result.outcome === "rejected" ? result.refusal! : "unexpected";
      expect(refusal).toContain("native-evidence-uncertain");
      fixture.registry.recordDeliveryOutcome(held.id, "failed", refusal, "lost");
    }
    const failedAt = Date.parse(fixture.registry.incomingDeliveryHealth(fixture.seat.conversationId)!.firstFailedAt!);
    fixture.seed();
    let rotated = 0;
    const step = async (offset: number) => {
      const rig = childRig(fixture, { now: failedAt + (15 + offset) * MINUTE, deliverWith: async message => {
        message.admissionGuard?.();
        const health = await host.health();
        if (health.status === "dead" || health.status === "unhosted") return {
          ok: false, outcome: "failed", status: 409, code: "structured_revival_impossible", admission: "refused", error: "fixture revival unavailable" };
        const receipt = await host.send({ id: message.clientMessageId!, text: message.text });
        expect(receipt.outcome).toBe("rejected");
        return { ok: false, outcome: "failed", status: 409, admission: "refused", error: "native broker refused before dispatch" };
      } });
      rig.deps.sources!.liveness = async () => {
        const health = await host.health();
        const alive = health.status === "idle";
        return [{ conversationId: fixture.seat.conversationId, verified: true, turnState: "idle",
          host: { state: alive ? "alive" : "gone", kind: "structured", pid: health.pid },
          reason: alive ? "host_alive_turn_idle" : "host_gone_turn_settled", lifecycle: "waiting",
          activity: { state: "idle", check: null, idleForMs: 30 * MINUTE } } as AgentLivenessRecord];
      };
      rig.deps.seatRecovery = { rotate: async () => { rotated++; return { status: 200, body: { ok: true } }; } };
      return runSeatTickCheck(fixture.project, rig.deps);
    };
    expect((await step(0))?.detail).toContain("cleanup is next");
    expect((await step(1))?.detail).toContain("cleanup confirmed");
    expect(await host.health()).toMatchObject({ status: "dead" });
    await step(2); expect(rotated).toBe(1); expect(f.wire).toHaveLength(0);
  } finally { await host.release(); journal.close(); fixture.registry.close(); setAgentRegistryForTests(null); }
}, 60_000);

test("successful recovery starts a distinct later episode even with the same clock and compacted history", async () => {
  const { setSystemTime } = await import("bun:test"); setSystemTime(new Date(NOW));
  const fixture = childFixture("incoming-next-episode");
  const { journal, sessionId } = hostedSeat(fixture);
  const key = { engine: "claude" as const, sessionId };
  fixture.registry.upsert({ ...fixture.registry.hostEntry(key)!, structuredHost: { ...fixture.registry.hostEntry(key)!.structuredHost!,
    process: { pid: 4100, startIdentity: "fixture-writer", bootEpoch: "fixture-boot" } } });
  fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(NOW).toISOString() }]);
  fixture.seed({ lastWakeAt: new Date(NOW).toISOString() });
  const keys: string[] = [];
  const fail = (id: string) => {
    const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture failure", id);
    fixture.registry.recordDeliveryOutcome(held.id, "failed", "fixture refusal", "lost");
  };
  const step = async (land: boolean, minutes = 20) => {
    setSystemTime(new Date(NOW + minutes * MINUTE));
    const rig = childRig(fixture, { now: NOW + minutes * MINUTE, seatActivity: { conversationId: fixture.seat.conversationId,
      verified: true, host: { state: "alive", kind: "structured", pid: 4100 }, turnState: "idle", reason: "host_alive_turn_idle",
      activity: { state: "idle", check: null, idleForMs: minutes * MINUTE } }, deliverWith: async message => {
      keys.push(message.clientMessageId!);
      if (!land) return { ok: false, outcome: "failed", status: 409, admission: "refused", error: "fixture pre-admission refusal" };
      const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, message.text, message.clientMessageId);
      fixture.registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
      return { ok: true, outcome: "delivered", target: "structured", structured: true };
    } });
    return runSeatTickCheck(fixture.project, rig.deps);
  };
  try {
    fail("episode-first-a"); fail("episode-first-b"); await step(true);
    expect(fixture.registry.incomingDeliveryHealth(fixture.seat.conversationId)?.failures).toBe(0);
    for (let i = 0; i < 205; i++) {
      const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture history", `history-${i}`);
      fixture.registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
    }
    fail("episode-second-a"); fail("episode-second-b");
    const secondHealth = fixture.registry.incomingDeliveryHealth(fixture.seat.conversationId)!;
    expect(secondHealth).toMatchObject({ failures: 2, firstFailedAt: new Date(NOW + 20 * MINUTE).toISOString(),
      lastDeliveredAt: new Date(NOW + 20 * MINUTE).toISOString() });
    await step(false, 36);
    expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
    expect(fixture.row().hostRecovery?.incoming?.phase).toBe("cleanup");
    await step(false, 36);
    expect(keys).toHaveLength(2);
    expect(fixture.row().hostRecovery).toMatchObject({ state: "pending", incoming: { phase: "cleanup" } });
  } finally { journal.close(); fixture.registry.close(); setSystemTime(); }
}, 30_000);

test("a pending nudge rebinds to a verified idle successor after reconciling its original key", async () => {
  const { setSystemTime } = await import("bun:test"); setSystemTime(new Date(NOW));
  const fixture = childFixture("incoming-rehost-rebind");
  const { journal, sessionId } = hostedSeat(fixture);
  const key = { engine: "claude" as const, sessionId };
  const entry = fixture.registry.hostEntry(key)!;
  fixture.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, activeTurnRef: "held-turn",
    process: { pid: 4100, startIdentity: "fixture-old-writer", bootEpoch: "fixture-boot" } } });
  fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: new Date(NOW).toISOString() }]);
  for (const id of ["rehost-failure-one", "rehost-failure-two"]) {
    const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture failure", id);
    fixture.registry.recordDeliveryOutcome(held.id, "failed", "fixture refusal", "lost");
  }
  try {
    const first = childRig(fixture, { now: NOW + 15 * MINUTE,
      seatActivity: { conversationId: fixture.seat.conversationId, verified: true, host: { state: "alive", kind: "structured", pid: 4100 },
        turnState: "busy", reason: "host_alive_turn_active", activity: { state: "working", check: null, idleForMs: 0 } } });
    await runSeatTickCheck(fixture.project, first.deps);
    expect(first.sent).toHaveLength(0);
    expect(fixture.row().hostRecovery?.incoming?.phase).toBe("nudge");

    const current = fixture.registry.hostEntry(key)!;
    fixture.registry.upsert({ ...current, claimEpoch: current.claimEpoch + 1,
      structuredHost: { ...current.structuredHost!, activeTurnRef: null, writerClaimEpoch: current.claimEpoch + 1,
        process: { pid: 4200, startIdentity: "fixture-new-writer", bootEpoch: "fixture-boot" } } });
    fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(NOW + 15 * MINUTE).toISOString() }]);
    const successor = childRig(fixture, { now: NOW + 16 * MINUTE,
      seatActivity: { conversationId: fixture.seat.conversationId, verified: true, host: { state: "alive", kind: "structured", pid: 4200 },
        turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle", activity: { state: "idle", check: null, idleForMs: MINUTE } } });
    const result = await runSeatTickCheck(fixture.project, successor.deps);
    expect(successor.sent).toHaveLength(0);
    expect(result?.detail).toContain("verified successor host adopted");
    const resumed = childRig(fixture, { now: NOW + 17 * MINUTE });
    resumed.deps.sources!.liveness = successor.deps.sources!.liveness;
    await runSeatTickCheck(fixture.project, resumed.deps);
    expect(resumed.sent).toHaveLength(1);
    expect(resumed.sent[0]!.clientMessageId).toContain("-nudge");
    expect(fixture.row().hostRecovery).toMatchObject({ state: "revived", incoming: { phase: "nudge", hostIdentity: expect.stringContaining("fixture-new-writer") } });
  } finally { journal.close(); fixture.registry.close(); setSystemTime(); }
}, 30_000);

test("cleanup recovery adopts a completed verified re-host and nudges without cleaning the successor", async () => {
  const { setSystemTime } = await import("bun:test"); setSystemTime(new Date(NOW));
  const fixture = childFixture("incoming-cleanup-rehost");
  const { journal, sessionId } = hostedSeat(fixture);
  const key = { engine: "claude" as const, sessionId };
  const original = fixture.registry.hostEntry(key)!;
  fixture.registry.upsert({ ...original, structuredHost: { ...original.structuredHost!,
    process: { pid: 4100, startIdentity: "fixture-original-writer", bootEpoch: "fixture-boot" } } });
  fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(NOW).toISOString() }]);
  for (const id of ["cleanup-rehost-failure-one", "cleanup-rehost-failure-two"]) {
    const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture failure", id);
    fixture.registry.recordDeliveryOutcome(held.id, "failed", "fixture refusal", "lost");
  }
  const oldEntry = fixture.registry.hostEntry(key)!;
  fixture.seed({ hostRecovery: { id: "cleanup-rehost-record", conversationId: fixture.seat.conversationId,
    seatEpoch: fixture.seat.seatEpoch, at: ago(fixture, 20), state: "pending", detail: "nudge failed", told: false,
    incoming: { since: ago(fixture, 20), episodeId: fixture.registry.incomingDeliveryHealth(fixture.seat.conversationId)?.episodeId,
      phase: "cleanup", attemptedAt: ago(fixture, 19),
      hostIdentity: JSON.stringify([sessionId, oldEntry.claimEpoch, oldEntry.claimOwner, oldEntry.structuredHost?.process]) } } });
  let cleanups = 0;
  try {
    const successorEntry = fixture.registry.hostEntry(key)!;
    fixture.registry.upsert({ ...successorEntry, claimEpoch: successorEntry.claimEpoch + 1,
      structuredHost: { ...successorEntry.structuredHost!, writerClaimEpoch: successorEntry.claimEpoch + 1,
        process: { pid: 4200, startIdentity: "fixture-successor-writer", bootEpoch: "fixture-boot" } } });
    const step = async (minute: number) => {
      setSystemTime(new Date(NOW + minute * MINUTE));
      const rig = childRig(fixture, { now: NOW + minute * MINUTE,
        seatActivity: { conversationId: fixture.seat.conversationId, verified: true,
          host: { state: "alive", kind: "structured", pid: 4200 }, turnState: "idle", lifecycle: "waiting",
          reason: "host_alive_turn_idle", activity: { state: "idle", check: null, idleForMs: minute * MINUTE } } });
      rig.deps.seatRecovery = { cleanup: async () => { cleanups++; return true; } };
      return { rig, result: await runSeatTickCheck(fixture.project, rig.deps) };
    };
    const adopted = await step(20);
    expect(adopted.result?.detail).toContain("verified successor host adopted");
    expect(fixture.row().hostRecovery?.incoming).toMatchObject({ phase: "nudge", hostIdentity: expect.stringContaining("fixture-successor-writer") });
    expect(adopted.rig.sent).toHaveLength(0);
    expect(cleanups).toBe(0);
    const nudged = await step(21);
    expect(nudged.rig.sent).toHaveLength(1);
    expect(nudged.rig.sent[0]!.clientMessageId).toContain("-nudge");
    expect(cleanups).toBe(0);
  } finally { journal.close(); fixture.registry.close(); setSystemTime(); }
}, 30_000);

test.each(["failed", "rotated", "superseded"] as const)("a terminal %s recovery from an earlier seat epoch does not own the successor", async state => {
  const { setSystemTime } = await import("bun:test"); setSystemTime(new Date(NOW));
  const fixture = childFixture(`incoming-terminal-epoch-${state}`);
  const { journal, sessionId } = hostedSeat(fixture);
  const key = { engine: "claude" as const, sessionId };
  fixture.registry.upsert({ ...fixture.registry.hostEntry(key)!, structuredHost: { ...fixture.registry.hostEntry(key)!.structuredHost!,
    process: { pid: 4100, startIdentity: "fixture-writer", bootEpoch: "fixture-boot" } } });
  fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(NOW).toISOString() }]);
  for (const id of ["epoch-failure-one", "epoch-failure-two"]) {
    const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture failure", id);
    fixture.registry.recordDeliveryOutcome(held.id, "failed", "fixture refusal", "lost");
  }
  fixture.seed({ hostRecovery: { id: `old-${state}`, conversationId: fixture.seat.conversationId, seatEpoch: fixture.seat.seatEpoch - 1,
    at: ago(fixture, 20), state, detail: "old epoch recovery", told: false,
    incoming: { since: ago(fixture, 20), episodeId: "old-episode", phase: "revive", attemptedAt: ago(fixture, 19) } } });
  try {
    const rig = childRig(fixture, { now: NOW + 15 * MINUTE,
      seatActivity: { conversationId: fixture.seat.conversationId, verified: true, host: { state: "alive", kind: "structured", pid: 4100 },
        turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle", activity: { state: "idle", check: null, idleForMs: 15 * MINUTE } } });
    await runSeatTickCheck(fixture.project, rig.deps);
    expect(fixture.row().hostRecovery).toMatchObject({ conversationId: fixture.seat.conversationId, seatEpoch: fixture.seat.seatEpoch,
      state: "revived", incoming: { episodeId: fixture.registry.incomingDeliveryHealth(fixture.seat.conversationId)?.episodeId } });
    expect(rig.cards.some(({ card }) => card.kind === "host-recovery" && card.instance === `old-${state}`
      && card.record?.includes("superseded"))).toBe(true);
  } finally { journal.close(); fixture.registry.close(); setSystemTime(); }
}, 30_000);

test("a replacement seat supersedes its predecessor's pending recovery and starts its own", async () => {
  const { setSystemTime } = await import("bun:test"); setSystemTime(new Date(NOW));
  const fixture = childFixture("incoming-successor-recovery");
  const { journal, sessionId } = hostedSeat(fixture);
  const key = { engine: "claude" as const, sessionId };
  fixture.registry.upsert({ ...fixture.registry.hostEntry(key)!, structuredHost: { ...fixture.registry.hostEntry(key)!.structuredHost!,
    process: { pid: 4100, startIdentity: "fixture-writer", bootEpoch: "fixture-boot" } } });
  fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(NOW).toISOString() }]);
  for (const id of ["successor-failure-one", "successor-failure-two"]) {
    const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture failure", id);
    fixture.registry.recordDeliveryOutcome(held.id, "failed", "fixture refusal", "lost");
  }
  fixture.seed({ hostRecovery: { id: "predecessor-recovery", conversationId: "conversation_predecessor", seatEpoch: 6,
    at: ago(fixture, 20), state: "pending", detail: "predecessor recovery pending", told: false,
    incoming: { since: ago(fixture, 20), episodeId: "predecessor-episode", phase: "cleanup", attemptedAt: ago(fixture, 19) } } });
  try {
    setSystemTime(new Date(NOW + 15 * MINUTE));
    const rig = childRig(fixture, { now: NOW + 15 * MINUTE,
      seatActivity: { conversationId: fixture.seat.conversationId, verified: true, host: { state: "alive", kind: "structured", pid: 4100 },
        turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle", activity: { state: "idle", check: null, idleForMs: 15 * MINUTE } } });
    const result = await runSeatTickCheck(fixture.project, rig.deps);
    expect(result?.detail).toContain("recovery input delivered");
    expect(rig.sent).toHaveLength(1);
    expect(fixture.row().hostRecovery).toMatchObject({ conversationId: fixture.seat.conversationId, seatEpoch: fixture.seat.seatEpoch, state: "revived" });
    expect(rig.cards.some(({ card }) => card.kind === "host-recovery" && card.instance === "predecessor-recovery"
      && card.record?.includes("superseded"))).toBe(true);
  } finally { journal.close(); fixture.registry.close(); setSystemTime(); }
});

test("two consecutive failures after designation recover despite an older failure", async () => {
  const { setSystemTime } = await import("bun:test"); setSystemTime(new Date(NOW));
  const fixture = childFixture("incoming-designation-bound");
  const { journal, sessionId } = hostedSeat(fixture);
  const key = { engine: "claude" as const, sessionId };
  fixture.registry.upsert({ ...fixture.registry.hostEntry(key)!, structuredHost: { ...fixture.registry.hostEntry(key)!.structuredHost!,
    process: { pid: 4100, startIdentity: "fixture-writer", bootEpoch: "fixture-boot" } } });
  fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(NOW).toISOString() }]);
  const fail = (id: string) => {
    const held = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture failure", id);
    fixture.registry.recordDeliveryOutcome(held.id, "failed", "fixture refusal", "lost");
  };
  try {
    fail("before-designation");
    const designatedAt = new Date(NOW + MINUTE).toISOString();
    const designatedSeat = { ...fixture.seat, designatedAt };
    setSystemTime(new Date(NOW + 2 * MINUTE)); fail("after-designation-one");
    setSystemTime(new Date(NOW + 3 * MINUTE)); fail("after-designation-two");
    expect(fixture.registry.incomingDeliveryHealth(fixture.seat.conversationId)).toMatchObject({
      failures: 3, penultimateFailedAt: new Date(NOW + 2 * MINUTE).toISOString(),
    });
    const checkAt = Date.parse(designatedAt) + 15 * MINUTE;
    setSystemTime(new Date(checkAt));
    const rig = childRig(fixture, { now: checkAt, seat: designatedSeat,
      seatActivity: { conversationId: fixture.seat.conversationId, verified: true, host: { state: "alive", kind: "structured", pid: 4100 },
        turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle", activity: { state: "idle", check: null, idleForMs: 15 * MINUTE } } });
    const result = await runSeatTickCheck(fixture.project, rig.deps);
    expect(result?.detail).toContain("recovery input delivered");
    expect(rig.sent).toHaveLength(1);
  } finally { journal.close(); fixture.registry.close(); setSystemTime(); }
});

test("delivered unanswered wake keeps its response deadline and nudge identity across controller restart", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "wake-response-")), "tick.json");
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, stateFile);
  const seat = { conversationId: CONVERSATION, seatEpoch: 7, path: "/srv/seat.jsonl" };
  const first = harness({ stateFile, seat, now: NOW, pipelines: OPEN_LANE });
  expect((await runSeatTickCheck(PROJECT, first.deps))?.verdict).toBe("wake");
  const response = readSeatTickState(PROJECT, stateFile).wakeResponse!;
  expect(response).toMatchObject({ conversationId: CONVERSATION, seatEpoch: 7, action: "pending", boundMs: 15 * MINUTE });
  const check = async (at: number, evidence: { answered: boolean; wait?: string } = { answered: false }) => {
    const rig = harness({ stateFile, seat, now: at, pipelines: OPEN_LANE,
      seatActivity: { conversationId: CONVERSATION, lifecycle: "waiting", reason: "host_alive_turn_idle", turnState: "idle" } });
    rig.deps.sources!.wakeResponse = async () => evidence;
    await runSeatTickCheck(PROJECT, rig.deps); return rig;
  };
  expect((await check(NOW + response.boundMs - 1)).sent).toEqual([]);
  const due = await check(NOW + response.boundMs);
  expect(due.sent).toHaveLength(1);
  expect(due.cards.some(entry => entry.card.ref === "seat-wake-response")).toBeTrue();
  expect(readSeatTickState(PROJECT, stateFile).wakeResponse?.action).toBe("nudged");
  expect((await check(NOW + response.boundMs + MINUTE)).sent).toEqual([]);
  await check(NOW + response.boundMs + 2 * MINUTE, { answered: true });
  expect(readSeatTickState(PROJECT, stateFile).wakeResponse).toBeUndefined();
});

test.each(["busy", "quota", "wait", "off", "rotation"])("unanswered delivered wake respects %s ownership and reports its hold", async condition => {
  const response = { clientMessageId: "original-wake", operationId: "original-operation", conversationId: CONVERSATION, seatEpoch: 7,
    deliveredAt: new Date(NOW - 20 * MINUTE).toISOString(), progressAt: new Date(NOW - 20 * MINUTE).toISOString(), boundMs: 15 * MINUTE, action: "pending" as const };
  const rig = harness({ seat: { conversationId: CONVERSATION, seatEpoch: condition === "rotation" ? 8 : 7, path: "/srv/seat.jsonl" },
    state: { ...RECENT, wakeResponse: response }, settings: condition === "off" ? { ...defaultSeatTickSettings(PROJECT), enabled: false } : undefined,
    seatActivity: { conversationId: CONVERSATION, lifecycle: "running", reason: "host_alive_turn_active", turnState: condition === "busy" ? "busy" : "idle" } });
  rig.deps.sources!.wakeResponse = async () => ({ answered: false, ...(condition === "wait" ? { wait: "foreground tool remains active" } : {}) });
  if (condition === "quota") rig.deps.sources!.recoverQuota = async () => true;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent.filter(message => message.clientMessageId?.startsWith("seat-response-"))).toHaveLength(0);
  if (condition === "busy" || condition === "wait") expect(rig.cards.some(entry => entry.card.ref === "seat-wake-response")).toBeTrue();
});


test.each([false, true])("wake response rotation requires a conclusively gone host: %s", async gone => {
  const rig = harness({ seat: { conversationId: CONVERSATION, seatEpoch: 7, path: "/srv/seat.jsonl" },
    state: { ...RECENT, wakeResponse: { clientMessageId: "unanswered", operationId: "original", conversationId: CONVERSATION, seatEpoch: 7,
      deliveredAt: new Date(NOW - 20 * MINUTE).toISOString(), progressAt: new Date(NOW - 20 * MINUTE).toISOString(), boundMs: 15 * MINUTE, action: "pending" } },
    seatActivity: { conversationId: CONVERSATION, turnState: gone ? "busy" : "idle", host: { state: gone ? "gone" : "alive", kind: "structured", pid: null },
      reason: gone ? "host_gone_turn_open" : "host_alive_turn_idle", lifecycle: gone ? "gone" : "waiting" },
    delivery: { ok: false, outcome: "failed", status: 503, error: "resume unavailable", code: "structured_revival_impossible" } });
  rig.deps.sources!.wakeResponse = async () => ({ answered: false });
  let rotations = 0;
  rig.deps.seatRecovery = { rotate: async () => { rotations++; return { status: 200, body: { ok: true } }; } };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rotations).toBe(gone ? 1 : 0);
});


test("an uncertain response nudge retries its original key after reopening", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "response-uncertain-")), "tick.json");
  const row = { clientMessageId: "unanswered", operationId: "original", conversationId: CONVERSATION, seatEpoch: 7,
    deliveredAt: new Date(NOW - 20 * MINUTE).toISOString(), progressAt: new Date(NOW - 20 * MINUTE).toISOString(), boundMs: 15 * MINUTE, action: "pending" as const };
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...RECENT, wakeResponse: row }, stateFile);
  const keys: string[] = [];
  const admitted = new Set<string>();
  for (const now of [NOW, NOW + MINUTE]) {
    const rig = harness({ stateFile, now, seat: { conversationId: CONVERSATION, seatEpoch: 7, path: "/srv/seat.jsonl" },
      seatActivity: { conversationId: CONVERSATION, turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle" },
      deliverWith: async message => { keys.push(message.clientMessageId!); admitted.add(message.clientMessageId!); throw new Error("fixture transport response lost"); } });
    rig.deps.sources!.wakeResponse = async () => ({ answered: false });
    await runSeatTickCheck(PROJECT, rig.deps);
    expect(readSeatTickState(PROJECT, stateFile).wakeResponse?.action).toBe("nudging");
  }
  expect(keys).toHaveLength(2); expect(admitted.size).toBe(1);
});


test("an expired response obligation fences a competing overdue agenda wake", async () => {
  const rig = harness({ seat: { conversationId: CONVERSATION, seatEpoch: 7, path: "/srv/seat.jsonl" }, pipelines: OPEN_LANE,
    state: { ...OVERDUE, wakeResponse: { clientMessageId: "unanswered", operationId: "original", conversationId: CONVERSATION, seatEpoch: 7,
      deliveredAt: new Date(NOW - 120 * MINUTE).toISOString(), progressAt: new Date(NOW - 120 * MINUTE).toISOString(), boundMs: 15 * MINUTE, action: "pending" } },
    seatActivity: { conversationId: CONVERSATION, turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle" } });
  rig.deps.sources!.wakeResponse = async () => ({ answered: false });
  expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).toBe("refused");
  expect(rig.sent).toHaveLength(1); expect(rig.sent[0]!.clientMessageId).toStartWith("seat-response-");
});


test.each(["repaired-auth", "pending-auth", "transient-error"])("provider failure response recovery respects its actual owner: %s", async condition => {
  const failedAt = NOW - 20 * MINUTE;
  const rig = harness({ seat: { conversationId: CONVERSATION, seatEpoch: 7, path: "/srv/seat.jsonl" },
    state: { ...RECENT, authRecoveredThrough: condition === "repaired-auth" ? failedAt : 0, wakeResponse: { clientMessageId: "unanswered", operationId: "original", conversationId: CONVERSATION, seatEpoch: 7,
      deliveredAt: new Date(failedAt).toISOString(), progressAt: new Date(failedAt).toISOString(), boundMs: 15 * MINUTE, action: "pending" } },
    seatActivity: { conversationId: CONVERSATION, turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle" } });
  rig.deps.sources!.wakeResponse = async () => ({ answered: false, providerFailure: true, wait: "provider recovery pending" });
  rig.deps.sources!.seatTurnOutcome = async () => ({ engine: "claude", accountId: null, path: "/srv/seat.jsonl", auth: condition === "transient-error" ? null : { ts: failedAt, text: "authentication failed" }, normalTurnTs: null });
  await runSeatTickCheck(PROJECT, rig.deps);
  const nudges = rig.sent.filter(message => message.clientMessageId?.startsWith("seat-response-"));
  expect(nudges).toHaveLength(condition === "pending-auth" ? 0 : 1);
});


test.each(["exhausted", "unknown", "available"])("%s quota recovery still accounts for a delivered outstanding wake", async capacity => {
  const wake = outstandingWake({ text: "retained wake" });
  const rig = harness({ state: { outstandingWake: wake }, wakeState: "landed" });
  rig.deps.sources!.recoverQuota = async () => { if (capacity === "unknown") throw new Error("fixture capacity evidence unavailable"); return capacity !== "available"; };
  await runSeatTickCheck(PROJECT, rig.deps);
  const state = rig.deps.readState!(PROJECT);
  expect(state.outstandingWake).toBeNull(); expect(state.lastWakeAt).toBe(new Date(NOW).toISOString());
  expect(state.wakeResponse?.clientMessageId).toBe(wake.clientMessageId);
  if (capacity !== "available") expect(rig.sent).toHaveLength(0);
});


test.each(["gone", "failed", "busy", "unknown", "wait", "quota", "composer", "control"])("a landed nudge has bounded dead-host recovery across restart: %s", async condition => {
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(SANDBOX, "landed-nudge-state-"));
  setSystemTime(NOW);
  try {
    const at = new Date(NOW - 30 * MINUTE).toISOString();
    beginOrchestratorSeatIntent({ project: PROJECT, mandate: "coordinate work", clientRequestId: "landed-nudge-seat", mode: "existing", now: at });
    completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "landed-nudge-seat", conversationId: CONVERSATION, path: "/srv/seat.jsonl", now: at });
    const seatEpoch = orchestratorSeatFor(PROJECT).active!.seatEpoch;
    const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "landed-nudge-")), "tick.json");
    const response: SeatWakeResponse = { clientMessageId: "original-wake", operationId: "original-operation", conversationId: CONVERSATION,
      seatEpoch, deliveredAt: new Date(NOW - 20 * MINUTE).toISOString(), progressAt: new Date(NOW - 20 * MINUTE).toISOString(), boundMs: 15 * MINUTE, action: "pending" };
    writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch, ...RECENT, wakeResponse: response }, stateFile);
    const seat = { conversationId: CONVERSATION, seatEpoch, path: "/srv/seat.jsonl" };
    const first = harness({ stateFile, seat, seatActivity: { conversationId: CONVERSATION, turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle" } });
    first.deps.sources!.wakeResponse = async () => ({ answered: false });
    await runSeatTickCheck(PROJECT, first.deps);
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]!.clientMessageId).toBe(wakeResponseRecoveryKey(response));
    expect(readSeatTickState(PROJECT, stateFile).wakeResponse).toMatchObject({ action: "nudged", operationId: response.operationId, progressAt: new Date(NOW).toISOString() });
    let rotations = 0;
    const check = async (at: number) => {
      const rig = harness({ stateFile, seat, now: at, pipelines: OPEN_LANE,
        seatActivity: { conversationId: CONVERSATION, turnState: condition === "unknown" ? "unknown" : "busy",
          lifecycle: condition === "busy" ? "running" : "gone", reason: condition === "busy" ? "host_alive_turn_active" : "host_gone_turn_open",
          host: { state: condition === "busy" ? "alive" : "gone", kind: "structured", pid: null } } });
      rig.deps.sources!.wakeResponse = async () => ({ answered: false, ...(condition === "wait" ? { wait: "delivery ownership uncertain" } : {}) });
      if (condition === "quota") rig.deps.sources!.recoverQuota = async () => true;
      let composer = false;
      const registry = rig.deps.sources!.registry;
      rig.deps.sources!.registry = () => new Proxy(registry(), { get(target, key, receiver) {
        if (composer && key === "seatMcpReceipt") return () => ({ createdAt: new Date(at).toISOString(), spawnCapabilityDigest: "b".repeat(64), viewerMcpTransport: "http" });
        return Reflect.get(target, key, receiver);
      } });
      rig.deps.seatRecovery = { rotate: async (body, _ports, _proof, admission) => {
        expect(body.expectedIncumbentSeatEpoch).toBe(seatEpoch);
        expect(body.handoffNotes).toContain(response.operationId);
        expect(await admission!.replacementHold!()).toBeNull();
        if (condition === "composer") composer = true;
        if (condition === "control") await cancelSeatQuotaOnControl(CONVERSATION);
        const hold = await admission!.replacementHold!();
        if (hold) return hold;
        rotations++;
        return condition === "failed" ? { status: 503, body: { error: "replacement unavailable" } } : { status: 200, body: { ok: true } };
      } };
      await runSeatTickCheck(PROJECT, rig.deps);
      expect(rig.sent).toEqual([]);
      return rig;
    };
    await check(NOW + response.boundMs - 1); expect(rotations).toBe(0);
    const due = await check(NOW + response.boundMs);
    expect(rotations).toBe(condition === "gone" || condition === "failed" ? 1 : 0);
    if (condition === "gone" || condition === "failed") {
      expect(readSeatTickState(PROJECT, stateFile).hostRecovery).toMatchObject({ state: condition === "gone" ? "rotated" : "failed", told: true });
      expect(due.cards.some(entry => entry.card.kind === "host-recovery")).toBe(true);
    }
    await check(NOW + 60 * MINUTE);
    expect(rotations).toBe(condition === "gone" || condition === "failed" ? 1 : 0);
    if (condition === "control") expect(readSeatTickState(PROJECT, stateFile).wakeResponse).toBeUndefined();
  } finally { setSystemTime(); if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; }
});


test.each(["idle", "busy", "exclusive", "unknown", "uncertain", "unproven-nudge", "control", "new-turn", "new-owner"] as const)("terminal failed nudge uses bounded existing rotation: %s", async condition => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "terminal-nudge-")), "tick.json");
  const at = new Date(NOW - 20 * MINUTE).toISOString();
  const response: SeatWakeResponse = { clientMessageId: "terminal-wake", operationId: "terminal-operation", conversationId: CONVERSATION,
    seatEpoch: 7, preparedAt: at, deliveredAt: at, progressAt: at, boundMs: 15 * MINUTE, action: "pending" };
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...RECENT, wakeResponse: response }, stateFile);
  const seat = { conversationId: CONVERSATION, seatEpoch: 7, path: "/srv/seat.jsonl" };
  const events: Record<string, unknown>[] = [{ kind: "turn-started", turnId: response.operationId },
    { kind: "turn-ended", turnId: response.operationId, status: "error" }];
  const first = harness({ stateFile, seat, seatActivity: { conversationId: CONVERSATION, turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle" } });
  first.deps.sources!.wakeResponse = async row => wakeResponseEvidenceFromEvents(row, events);
  await runSeatTickCheck(PROJECT, first.deps);
  expect(first.sent).toHaveLength(1);
  const key = first.sent[0]!.clientMessageId!;
  events.push({ kind: "turn-started", turnId: key },
    { kind: "item", turnId: key, item: { type: "assistant", error: "transient-provider-failure", isApiErrorMessage: true } },
    { kind: "turn-ended", turnId: key, status: "error" });
  expect(readSeatTickState(PROJECT, stateFile).wakeResponse?.action).toBe("nudged");
  let rotations = 0;
  const check = async (now: number) => {
    // New controller and state reader on every check, including after admission.
    const rig = harness({ stateFile, seat, now, pipelines: OPEN_LANE,
      seatActivity: { conversationId: CONVERSATION, turnState: condition === "busy" ? "busy" : condition === "unknown" ? "unknown" : "idle",
        lifecycle: "waiting", reason: "host_alive_turn_idle", host: { state: "alive", kind: "structured", pid: null },
        ...(condition === "exclusive" ? { activity: { state: "checking", check: "owned foreground command", idleForMs: null } } : {}) } });
    rig.deps.sources!.wakeResponse = async row => ({ ...wakeResponseEvidenceFromEvents(row, condition === "unproven-nudge" ? events.slice(0, 2) : events, [key]),
      ...(condition === "uncertain" ? { providerFailure: false, wait: "delivery ownership uncertain" } : {}) });
    if (condition === "control") rig.deps.sources!.settings = () => ({ ...defaultSeatTickSettings(PROJECT), enabled: false });
    rig.deps.seatRecovery = { rotate: async (body, _ports, _proof, admission) => {
      expect(body.expectedIncumbentSeatEpoch).toBe(7);
      expect(body.handoffNotes).toContain(response.operationId);
      expect(admission!.automaticReplacement).toEqual({ conversationId: CONVERSATION, seatEpoch: 7 });
      expect(await admission!.replacementHold!()).toBeNull();
      if (condition === "new-turn") {
        const registry = rig.deps.sources!.registry();
        rig.deps.sources!.registry = () => ({ ...registry, seatTickConversation: () => ({ id: CONVERSATION, turn: { state: "busy" } }) }) as never;
        rig.deps.sources!.liveness = async () => [{ conversationId: CONVERSATION, turnState: "busy" }] as AgentLivenessRecord[];
      }
      if (condition === "new-owner") rig.seat = { ...seat, seatEpoch: 8 };
      const held = await admission!.replacementHold!();
      if (held) return held;
      rotations++;
      return { status: 200, body: { ok: true } };
    } };
    await runSeatTickCheck(PROJECT, rig.deps);
    expect(rig.sent).toEqual([]);
  };
  await check(NOW + response.boundMs - 1);
  expect(rotations).toBe(0);
  await check(NOW + response.boundMs);
  expect(rotations).toBe(condition === "idle" ? 1 : 0);
  await check(NOW + 60 * MINUTE);
  expect(rotations).toBe(condition === "idle" ? 1 : 0);
});


test("serialize a newer agenda wake until the older answer reconciles and retain its frozen response through restart", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "serialized-response-")), "tick.json");
  const old: SeatWakeResponse = { clientMessageId: "older-wake", operationId: "older-operation", conversationId: CONVERSATION, seatEpoch: 7,
    deliveredAt: OVERDUE.lastWakeAt, progressAt: new Date(NOW - 5 * MINUTE).toISOString(), boundMs: 15 * MINUTE, action: "pending" };
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, wakeResponse: old }, stateFile);
  const events: Record<string, unknown>[] = [{ kind: "turn-started", turnId: old.operationId },
    { kind: "item", turnId: old.operationId, accountingAt: old.progressAt, item: { type: "reasoning", text: "recent work" } }];
  const seat = { conversationId: CONVERSATION, seatEpoch: 7, path: "/srv/seat.jsonl" };
  const check = async (now: number) => {
    const rig = harness({ stateFile, seat, now, pipelines: OPEN_LANE,
      seatActivity: { conversationId: CONVERSATION, turnState: "idle", lifecycle: "waiting", reason: "host_alive_turn_idle" },
      deliverWith: async message => {
        // The older answer arrives at the new send boundary, as in the report.
        events.push({ kind: "delta", turnId: old.operationId, text: "older answer" },
          { kind: "turn-ended", turnId: old.operationId, status: "completed" },
          { kind: "turn-started", turnId: message.clientMessageId },
          { kind: "turn-ended", turnId: message.clientMessageId, status: "error" });
        return { ok: true, target: "structured", outcome: "delivered", structured: true };
      } });
    rig.deps.sources!.wakeResponse = async row => wakeResponseEvidenceFromEvents(row, events);
    await runSeatTickCheck(PROJECT, rig.deps);
    return rig;
  };
  const held = await check(NOW);
  expect(held.sent).toEqual([]);
  expect(readSeatTickState(PROJECT, stateFile).wakeResponse?.clientMessageId).toBe(old.clientMessageId);
  events.push({ kind: "delta", turnId: old.operationId, text: "older answer" },
    { kind: "turn-ended", turnId: old.operationId, status: "completed" });
  const delivered = await check(NOW + MINUTE);
  expect(delivered.sent).toHaveLength(1);
  const key = delivered.sent[0]!.clientMessageId!;
  expect(key).not.toStartWith("seat-response-");
  const row = readSeatTickState(PROJECT, stateFile).wakeResponse!;
  expect(row).toMatchObject({ clientMessageId: key, operationId: key, boundMs: 15 * MINUTE, action: "pending" });
  expect(row.preparedAt).toBe(new Date(NOW + MINUTE).toISOString());
  expect(readSeatTickState(PROJECT, stateFile).outstandingWake).toBeNull();
  expect((await check(NOW + 2 * MINUTE)).sent).toEqual([]);
  expect(readSeatTickState(PROJECT, stateFile).wakeResponse).toEqual({ ...row, turnId: key });
  expect((await check(NOW + MINUTE + row.boundMs - 1)).sent).toEqual([]);
  const due = await check(NOW + MINUTE + row.boundMs);
  expect(due.sent).toHaveLength(1);
  expect(due.sent[0]!.clientMessageId).toBe(wakeResponseRecoveryKey(row));
});

function reviewSetup(label: string) {
  const fixture = childFixture(label);
  const { journal, client, sessionId } = hostedSeat(fixture);
  const key = { engine: "claude" as const, sessionId };
  const entry = fixture.registry.hostEntry(key)!;
  fixture.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, activeTurnRef: null,
    process: { pid: 4100, startIdentity: "fixture-original", bootEpoch: "fixture-boot" } } });
  fixture.registry.reconcileConversations([{ engine: "claude", path: fixture.seat.path!, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd }), turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(NOW).toISOString() }]);
  const fail = (id: string) => {
    const row = fixture.registry.holdDelivery(fixture.seat.conversationId as never, "fixture failure", id,
      "text", [], null, { operationId: id, kind: "send", policy: "queue" });
    fixture.registry.recordDeliveryOutcome(row.id, "failed", "fixture refusal", "lost");
  };
  fail("review-first"); fail("review-second"); fixture.seed({ lastWakeAt: new Date(NOW).toISOString() });
  const ready = (minute: number) => {
    const rig = childRig(fixture, { now: NOW + minute * MINUTE,
      seatActivity: { conversationId: fixture.seat.conversationId, verified: true, turnState: "idle", lifecycle: "waiting",
        host: { state: "alive", kind: "structured", pid: fixture.registry.hostEntry(key)!.structuredHost?.process?.pid ?? null },
        reason: "host_alive_turn_idle", activity: { state: "idle", check: null, idleForMs: minute * MINUTE } } });
    rig.deps.sources!.registry = () => fixture.registry;
    return rig;
  };
  return { fixture, journal, client, sessionId, key, fail, ready };
}

test.each(["reserved", "pre-reservation"] as const)("review probe: durable failed nudge after completed rehost must test successor delivery (%s)", async admission => {
  setSystemTime(new Date(NOW));
  const f = reviewSetup("review-durable-rehost");
  try {
    setSystemTime(new Date(NOW + 15 * MINUTE));
    const first = f.ready(15);
    first.deps.seatRecovery = { client: f.client };
    let originalNudgeKey = "";
    first.deps.deliver = async message => {
      originalNudgeKey = message.clientMessageId!;
      if (admission === "pre-reservation") return { ok: false, outcome: "failed", status: 409, admission: "refused", error: "fixture pre-reservation refusal" };
      const held = f.fixture.registry.holdDelivery(f.fixture.seat.conversationId as never, message.text, message.clientMessageId);
      f.journal.executeOperation({ kind: "send", operationId: held.command.operationId, idempotencyKey: message.clientMessageId!,
        conversationId: f.fixture.seat.conversationId, text: message.text, policy: "queue" });
      f.journal.transitionOperation(held.command.operationId, "failed", { reason: "fixture definitive refusal" });
      f.fixture.registry.recordDeliveryOutcome(held.id, "failed", "fixture definitive refusal", "lost");
      return { ok: false, outcome: "failed", status: 409, admission: "refused", resend: "safe", operationId: held.command.operationId, error: "fixture refused" };
    };
    await runSeatTickCheck(f.fixture.project, first.deps);
    expect(f.fixture.row().hostRecovery?.incoming?.phase).toBe("cleanup");
    const old = f.fixture.registry.hostEntry(f.key)!;
    f.fixture.registry.upsert({ ...old, claimEpoch: old.claimEpoch + 1, structuredHost: { ...old.structuredHost!, writerClaimEpoch: old.claimEpoch + 1,
      process: { pid: 4200, startIdentity: "fixture-successor", bootEpoch: "fixture-boot" } } });
    let cleanups = 0, sends = 0;
    for (const minute of [16, 17, 18]) {
      setSystemTime(new Date(NOW + minute * MINUTE));
      if (minute === 17) {
        const filename = f.fixture.registry.filename;
        f.fixture.registry.close();
        f.fixture.registry = new AgentRegistry(filename, () => false, undefined, { sqliteMode: "sqlite" });
      }
      const rig = f.ready(minute);
      rig.deps.seatRecovery = { client: f.client, cleanup: async () => { cleanups++; return false; } };
      await runSeatTickCheck(f.fixture.project, rig.deps);
      sends += rig.sent.length;
      if (rig.sent.length) expect(rig.sent[0]!.clientMessageId).not.toBe(originalNudgeKey);
    }
    expect(sends).toBe(1);
    expect(cleanups).toBe(0);
    expect(f.fixture.row().hostRecovery?.incoming?.nudgeAttempt).toBe(1);
    const oldOwners = Object.values(f.fixture.registry.deliverySnapshotForMessageKey(f.fixture.seat.conversationId!, originalNudgeKey).deliveryOperationOwners);
    expect(oldOwners).toHaveLength(admission === "reserved" ? 1 : 0);
    if (admission === "reserved") expect(oldOwners[0]).toMatchObject({ terminalState: "failed", terminalDisposition: "lost" });
  } finally { f.journal.close(); f.fixture.registry.close(); setSystemTime(); }
});

test.each(["current", "legacy"] as const)("review probe: resolved uncertain delivery releases previous pending recovery (%s)", async format => {
  setSystemTime(new Date(NOW));
  const f = reviewSetup("review-uncertain-episode");
  try {
    const priorSuccess = f.fixture.registry.holdDelivery(f.fixture.seat.conversationId as never, "fixture prior recovery", "review-prior-success");
    f.fixture.registry.recordDeliveryOutcome(priorSuccess.id, "delivered", null, "delivered");
    f.fail("review-current-one"); f.fail("review-current-two");
    const entry = f.fixture.registry.hostEntry(f.key)!;
    f.fixture.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, activeTurnRef: "real-turn" } });
    setSystemTime(new Date(NOW + 15 * MINUTE));
    await runSeatTickCheck(f.fixture.project, f.ready(15).deps);
    expect(f.fixture.row().hostRecovery?.state).toBe("pending");
    const oldEpisode = f.fixture.row().hostRecovery?.incoming?.episodeId;
    if (format === "legacy") {
      const row = f.fixture.row();
      delete row.hostRecovery!.incoming!.episodeAdmissionSeq;
      writeSeatTickState(f.fixture.project, row, f.fixture.stateFile);
    }
    setSystemTime(new Date(NOW + 16 * MINUTE));
    const unknown = f.fixture.registry.holdDelivery(f.fixture.seat.conversationId as never, "fixture uncertain", "review-uncertain");
    f.fixture.registry.recordDeliveryOutcome(unknown.id, "failed", "fixture uncertain receipt", "unverified");
    setSystemTime(new Date(NOW + 17 * MINUTE)); f.fail("review-new-one"); f.fail("review-new-two");
    f.fixture.registry.recordDeliveryOutcomeForOperation(f.fixture.seat.conversationId as never, unknown.command.operationId, "delivered", null, "delivered");
    const active = f.fixture.registry.hostEntry(f.key)!;
    f.fixture.registry.upsert({ ...active, structuredHost: { ...active.structuredHost!, activeTurnRef: null } });
    setSystemTime(new Date(NOW + 36 * MINUTE));
    const rig = f.ready(36);
    const health = f.fixture.registry.incomingDeliveryHealth(f.fixture.seat.conversationId)!;
    expect(health).toMatchObject({ failures: 2, uncertain: 0, lastDeliveredAdmissionSeq: 6, lastOutcomeAdmissionSeq: 8 });
    const early = f.ready(31);
    await runSeatTickCheck(f.fixture.project, early.deps);
    expect(early.sent).toHaveLength(0);
    await runSeatTickCheck(f.fixture.project, rig.deps);
    expect(rig.sent).toHaveLength(1);
    expect(f.fixture.row().hostRecovery?.incoming?.episodeId).not.toBe(oldEpisode);
    expect(rig.sent[0]!.clientMessageId).not.toBe(unknown.clientMessageId);
    expect(f.fixture.registry.deliverySnapshotForOperation(unknown.command.operationId)
      .deliveryOperationOwners[unknown.command.operationId]?.terminalState).toBe("delivered");
    const repeated = f.ready(37);
    await runSeatTickCheck(f.fixture.project, repeated.deps);
    expect(repeated.sent).toHaveLength(0);
  } finally { f.journal.close(); f.fixture.registry.close(); setSystemTime(); }
});

test("review probe: completed cleanup with lost phase write proceeds to revival", async () => {
  setSystemTime(new Date(NOW));
  const f = reviewSetup("review-cleanup-phase-cut");
  try {
    setSystemTime(new Date(NOW + 15 * MINUTE));
    const first = f.ready(15);
    first.deps.deliver = async () => ({ ok: false, outcome: "failed", status: 409, admission: "refused", error: "fixture pre-reservation refusal" });
    await runSeatTickCheck(f.fixture.project, first.deps);
    expect(f.fixture.row().hostRecovery?.incoming?.phase).toBe("cleanup");
    let cleanups = 0, revivals = 0;
    const interrupted = f.ready(16);
    interrupted.deps.seatRecovery = { cleanup: async () => {
      cleanups++;
      const entry = f.fixture.registry.hostEntry(f.key)!;
      expect(f.fixture.registry.terminateStructuredHost(f.key, entry.structuredHost!.process!, [])).toBe(true);
      throw new Error("fixture controller stopped before phase write");
    } };
    await runSeatTickCheck(f.fixture.project, interrupted.deps);
    expect(f.fixture.row().hostRecovery?.incoming?.phase).toBe("cleanup");
    const filename = f.fixture.registry.filename;
    f.fixture.registry.close();
    f.fixture.registry = new AgentRegistry(filename, () => false, undefined, { sqliteMode: "sqlite" });
    for (const minute of [17, 20, 21]) {
      setSystemTime(new Date(NOW + minute * MINUTE));
      const rig = f.ready(minute);
      rig.deps.sources!.liveness = async () => [{ conversationId: f.fixture.seat.conversationId, verified: true,
        turnState: "idle", host: { state: "gone", kind: "none", pid: null }, reason: "host_gone_turn_settled" } as AgentLivenessRecord];
      rig.deps.seatRecovery = { cleanup: async () => { cleanups++; return false; } };
      await runSeatTickCheck(f.fixture.project, rig.deps);
      revivals += rig.sent.length;
    }
    expect(f.fixture.row().hostRecovery?.incoming?.phase).toBe("revive");
    expect(f.fixture.row().hostRecovery?.state).toBe("revived");
    expect(cleanups).toBe(1);
    expect(revivals).toBe(1);
  } finally { f.journal.close(); f.fixture.registry.close(); setSystemTime(); }
});

test("a re-host keeps an unsettled original nudge fenced", async () => {
  setSystemTime(new Date(NOW));
  const f = reviewSetup("rehost-uncertain-nudge");
  let inputKey = "", operationId = "", cleanups = 0;
  try {
    setSystemTime(new Date(NOW + 15 * MINUTE));
    const first = f.ready(15);
    first.deps.seatRecovery = { client: f.client };
    first.deps.deliver = async message => {
      inputKey = message.clientMessageId!;
      const held = f.fixture.registry.holdDelivery(f.fixture.seat.conversationId as never, message.text, inputKey);
      operationId = held.command.operationId;
      f.journal.executeOperation({ kind: "send", operationId, idempotencyKey: inputKey,
        conversationId: f.fixture.seat.conversationId, text: message.text, policy: "queue" });
      return { ok: true, outcome: "queued", target: "structured", operationId };
    };
    await runSeatTickCheck(f.fixture.project, first.deps);
    const original = f.fixture.row().hostRecovery!;
    const old = f.fixture.registry.hostEntry(f.key)!;
    f.fixture.registry.upsert({ ...old, claimEpoch: old.claimEpoch + 1,
      structuredHost: { ...old.structuredHost!, writerClaimEpoch: old.claimEpoch + 1,
        process: captureProcessIdentity(process.pid) } });
    for (const minute of [16, 17]) {
      setSystemTime(new Date(NOW + minute * MINUTE));
      const rig = f.ready(minute);
      rig.deps.seatRecovery = { client: f.client, cleanup: async () => { cleanups++; return false; } };
      await runSeatTickCheck(f.fixture.project, rig.deps);
      expect(rig.sent).toHaveLength(0);
    }
    expect(cleanups).toBe(0);
    expect(f.fixture.row().hostRecovery?.incoming).toEqual(original.incoming!);
    expect(f.fixture.registry.deliverySnapshotForMessageKey(f.fixture.seat.conversationId!, inputKey)
      .deliveryOperationOwners[operationId]?.terminalState).toBeNull();
  } finally { f.journal.close(); f.fixture.registry.close(); setSystemTime(); }
});

test("a replacement during terminal cleanup observation cannot inherit cleanup authority", async () => {
  setSystemTime(new Date(NOW));
  const f = reviewSetup("cleanup-observation-replacement");
  try {
    const first = f.ready(15);
    first.deps.deliver = async () => ({ ok: false, outcome: "failed", status: 409, admission: "refused", error: "fixture refusal" });
    await runSeatTickCheck(f.fixture.project, first.deps);
    const entry = f.fixture.registry.hostEntry(f.key)!;
    f.fixture.registry.terminateStructuredHost(f.key, entry.structuredHost!.process!, []);
    const rig = f.ready(16);
    let cleanups = 0;
    rig.deps.seatRecovery = { cleanup: async () => { cleanups++; return false; } };
    rig.deps.sources!.liveness = async () => {
      const retired = f.fixture.registry.hostEntry(f.key)!;
      f.fixture.registry.upsert({ ...retired, claimEpoch: retired.claimEpoch + 1,
        structuredHost: { ...entry.structuredHost!, writerClaimEpoch: retired.claimEpoch + 1,
          process: { pid: 4200, startIdentity: "fixture-racing-successor", bootEpoch: "fixture-boot" } } });
      return [{ conversationId: f.fixture.seat.conversationId, verified: true, turnState: "idle",
        host: { state: "gone", kind: "none", pid: null }, reason: "host_gone_turn_settled" } as AgentLivenessRecord];
    };
    await runSeatTickCheck(f.fixture.project, rig.deps);
    expect(rig.sent).toHaveLength(0);
    expect(cleanups).toBe(0);
    expect(f.fixture.row().hostRecovery?.incoming?.phase).toBe("cleanup");
    expect(f.fixture.registry.hostEntry(f.key)?.structuredHost?.process?.startIdentity).toBe("fixture-racing-successor");
  } finally { f.journal.close(); f.fixture.registry.close(); setSystemTime(); }
});

test.each(["current", "legacy", "later-failure"] as const)("a late success preceding a captured failure keeps recovery pending (%s)", async format => {
  setSystemTime(new Date(NOW));
  const f = reviewSetup(`late-success-with-newer-failure-${format}`);
  try {
    const conversationId = f.fixture.registry.conversation(f.fixture.seat.conversationId as never)!.id;
    const pending = f.fixture.registry.recordDirectAdmission({ handOff: {
      conversationId, clientMessageId: "late-middle-input",
      command: { operationId: "late-middle-input", kind: "send", policy: "queue" }, text: "fixture input",
      contentDigest: null, evidenceText: "fixture input", evidenceImageCount: 0 } })!;
    f.fail("late-newer-failure");
    const entry = f.fixture.registry.hostEntry(f.key)!;
    f.fixture.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, activeTurnRef: "fixture-work" } });
    await runSeatTickCheck(f.fixture.project, f.ready(15).deps);
    expect(f.fixture.row().hostRecovery?.state).toBe("pending");
    if (format === "legacy") {
      const row = f.fixture.row();
      delete row.hostRecovery!.incoming!.episodeAdmissionSeq;
      writeSeatTickState(f.fixture.project, row, f.fixture.stateFile);
    }
    if (format === "later-failure") {
      const later = f.fixture.registry.recordDirectAdmission({ handOff: {
        conversationId, clientMessageId: "late-after-recovery",
        command: { operationId: "late-after-recovery", kind: "send", policy: "queue" }, text: "fixture later input",
        contentDigest: null, evidenceText: "fixture later input", evidenceImageCount: 0 } })!;
      f.fail("failure-after-pending-recovery");
      f.fixture.registry.settleDirectAdmission(later.command.operationId, "delivered", null, "delivered");
    }
    setSystemTime(new Date(NOW + 16 * MINUTE));
    f.fixture.registry.settleDirectAdmission(pending.command.operationId, "delivered", null, "delivered");
    await runSeatTickCheck(f.fixture.project, f.ready(16).deps);
    expect(f.fixture.row().hostRecovery?.state).toBe("pending");
    const active = f.fixture.registry.hostEntry(f.key)!;
    f.fixture.registry.upsert({ ...active, structuredHost: { ...active.structuredHost!, activeTurnRef: null } });
    const idle = f.ready(17);
    await runSeatTickCheck(f.fixture.project, idle.deps);
    expect(idle.sent).toHaveLength(1);
  } finally { f.journal.close(); f.fixture.registry.close(); setSystemTime(); }
});
