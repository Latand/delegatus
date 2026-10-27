import nodeCrypto from "node:crypto";
import { spyOn } from "bun:test";
import { expect, test, childFixture, setAgentRegistryForTests, ago, hostedSeat, createFakeDeliveryLedger, StructuredDeliveryQueue, FakeEngineHost, childRig, realTransport, runSeatTickCheck, NOW } from "./seatTickController.fixture";
import type { HostState } from "@/lib/runtime/engineHost";

test("a queued tick wake is written once when the queue drains an already-idle seat (#2695)", async () => {
  const Clock = Date;
  globalThis.Date = new Proxy(Clock, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [NOW]); },
    get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); },
  });
  let nextId = 0;
  const nextUUID = (): ReturnType<typeof nodeCrypto.randomUUID> =>
    `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
  const nodeIds = spyOn(nodeCrypto, "randomUUID").mockImplementation(nextUUID);
  const webIds = spyOn(globalThis.crypto, "randomUUID").mockImplementation(nextUUID);
  try {
    const fixture = childFixture("idle-seat-tick-wake");
    setAgentRegistryForTests(fixture.registry);
    fixture.spawn({ title: "decision waiting", turn: "terminal", terminalAt: ago(fixture, 20) });
    fixture.seed();
    const { journal, client } = hostedSeat(fixture);
    const seatHost: HostState = {
      status: "idle", sessionKey: "seat-session", endpoint: "fixture:seat-host", pid: 1,
      processStartIdentity: "fixture:1", eventCursor: 0, protocolVersion: "fixture-v1",
      activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null,
    };
    const ledger = createFakeDeliveryLedger();
    const queue = new StructuredDeliveryQueue({
      effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
      transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
      status: async (id) => journal.operationResult(id)?.receipt ?? null,
      settled: () => false,
    }, () => new FakeEngineHost(ledger, seatHost));
    try {
      const raised = childRig(fixture, { realWakeState: true, journal: { client }, settlementNow: () => NOW,
        deliverWith: realTransport(fixture, client) });
      expect(await runSeatTickCheck(fixture.project, raised.deps)).toMatchObject({
        verdict: "wake", delivery: { outcome: "queued" },
      });
      const wake = fixture.row().outstandingWake!;

      // No conversation event or operator send occurs between admission and delivery.
      await queue.drain();
      await queue.drain();
      expect(ledger.writes.map((entry) => entry.id)).toEqual([wake.operationId!]);
      expect(journal.operationResult(wake.operationId!)?.receipt.status).toBe("delivered");
    } finally {
      journal.close();
    }
  } finally {
    webIds.mockRestore();
    nodeIds.mockRestore();
  }
});
