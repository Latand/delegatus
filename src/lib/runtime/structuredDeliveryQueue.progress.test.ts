import { expect, test } from "bun:test";

import type { DeliveryReceipt, EngineHost, HostState, QueueEntry, RuntimeEvent } from "./engineHost";
import { DeliveryProgressStore } from "./deliveryProgress";
import { DELIVERY_WAIT_REASONS } from "./deliveryWaitReason";
import {
  StructuredDeliveryQueue,
  type StructuredDeliveryEffect,
  type StructuredDeliveryQueuePort,
  type StructuredDeliveryQueueTiming,
} from "./structuredDeliveryQueue";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";

/*
 * Incident 2026-10-06: two operator messages waited 409 s and 515 s before
 * host dispatch and nothing recorded why. These drive the delivery queue with
 * fault injection on fakes only: no registry, no runtime host, no state
 * directory. A hanging target, a lost wake, a lock delay and a late
 * acknowledgement each have to leave the other conversation's delivery alone,
 * leave a truthful wait reason, and produce at most one host input for the
 * original operation.
 */

const TERMINAL = new Set(["delivered", "failed", "uncertain", "rejected", "turn-started", "steered"]);

interface JournalOp {
  operationId: string;
  conversationId: string;
  text: string;
  policy: "queue" | "interrupt-active";
  status: string;
  revision: number;
  reason: string | null;
  seq: number;
}

/** An in-memory journal with the real one's two rules that matter here: a
    terminal operation leaves the effect listing, and no transition leaves a
    terminal status. */
function fakeJournal() {
  const ops = new Map<string, JournalOp>();
  let seq = 0;
  const transitions: Array<[string, string]> = [];
  let delay: (operationId: string, status: string) => Promise<void> = async () => {};
  let loseAck: (operationId: string, status: string) => boolean = () => false;
  return {
    ops,
    transitions,
    admit(operationId: string, conversationId: string, policy: JournalOp["policy"] = "queue") {
      seq += 1;
      ops.set(operationId, { operationId, conversationId, text: `text of ${operationId}`, policy, status: "queued", revision: 1, reason: null, seq });
    },
    delayTransitions(next: typeof delay) { delay = next; },
    loseAcknowledgements(next: typeof loseAck) { loseAck = next; },
    port(extra: Partial<StructuredDeliveryQueuePort> = {}, claim = "owner:1"): StructuredDeliveryQueuePort {
      return {
        effects: async (): Promise<StructuredDeliveryEffect[]> => [...ops.values()]
          .filter((op) => !TERMINAL.has(op.status))
          .map((op) => ({
            id: `effect:${op.operationId}`,
            kind: "runtime.send",
            eventSeq: op.seq,
            payload: { kind: "send", operationId: op.operationId, conversationId: op.conversationId, text: op.text, policy: op.policy },
          })),
        status: async (operationId) => {
          const op = ops.get(operationId);
          return op ? { status: op.status, revision: op.revision, reason: op.reason } : null;
        },
        settled: async () => false,
        hostClaim: async () => claim,
        transition: async (operationId, status, details, options) => {
          await delay(operationId, status);
          const op = ops.get(operationId);
          if (!op) throw new Error("runtime operation is unknown");
          if (options?.fromStatuses && !options.fromStatuses.includes(op.status as never)) {
            throw new Error("runtime operation moved before its transition");
          }
          if (TERMINAL.has(op.status)) {
            if (op.status === status) return;
            throw new Error("runtime operation transition is invalid");
          }
          if (op.status !== status) {
            op.status = status;
            op.revision += 1;
          }
          op.reason = details?.reason ?? (status === "queued" ? op.reason : null);
          transitions.push([operationId, status]);
          if (loseAck(operationId, status)) throw new Error("runtime host request timed out");
        },
        ...extra,
      };
    },
  };
}

function idleState(activeTurnRef: string | null = null): HostState {
  return {
    status: activeTurnRef ? "active" : "idle",
    sessionKey: "session-one",
    endpoint: "test:host",
    pid: 1,
    processStartIdentity: "1",
    eventCursor: 0,
    protocolVersion: "test",
    activeTurnRef,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  };
}

function fakeHost(send: (entry: QueueEntry) => Promise<DeliveryReceipt>, health: () => HostState = () => idleState()) {
  const inputs: string[] = [];
  const interrupts: string[] = [];
  const engine: EngineHost = {
    supportsSteer: true,
    attach: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {} }),
    send: async (entry) => { inputs.push(entry.id); return send(entry); },
    interrupt: async (turnRef) => { interrupts.push(turnRef); },
    answer: async () => {},
    health: async () => health(),
    release: async () => {},
  };
  return { engine, inputs, interrupts };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const delivered = (): Promise<DeliveryReceipt> => Promise.resolve({ outcome: "turn-started", turnId: "turn-next" });
const never = (): Promise<DeliveryReceipt> => new Promise(() => {});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clock(start = Date.parse("2026-10-06T12:00:00.000Z")) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function queueFor(
  port: StructuredDeliveryQueuePort,
  hosts: Record<string, EngineHost>,
  timing: Partial<StructuredDeliveryQueueTiming>,
  onWake: () => void = () => {},
): StructuredDeliveryQueue {
  return new StructuredDeliveryQueue(port, (conversationId) => hosts[conversationId] ?? null,
    undefined, onWake, undefined, undefined, undefined, undefined, timing);
}

test("every wait reason has a sentence in both interface languages", () => {
  for (const reason of DELIVERY_WAIT_REASONS) {
    expect(en[`delivery.wait.${reason}` as keyof typeof en]).toBeTruthy();
    expect(uk[`delivery.wait.${reason}` as keyof typeof uk]).toBeTruthy();
  }
});

test("a hanging target holds only its own conversation: another delivers within its pass budget and the hung send is never repeated", async () => {
  const time = clock();
  const journal = fakeJournal();
  const progress = new DeliveryProgressStore(null, time.now);
  const hung = fakeHost(never);
  const other = fakeHost(delivered);
  journal.admit("op-a", "conversation-a");
  journal.admit("op-b", "conversation-b");
  const queue = queueFor(journal.port({ progress }), { "conversation-a": hung.engine, "conversation-b": other.engine },
    { passBudgetMs: 40, stallMs: 5_000, safetyPassMs: 60_000, interruptReconcileMs: 30_000, now: time.now });

  const started = performance.now();
  await queue.drain();
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(journal.ops.get("op-b")!.status).toBe("delivered");
  expect(progress.get("op-b")?.terminal?.state).toBe("delivered");

  /* The next admission to the other conversation is not held behind the hang. */
  journal.admit("op-b2", "conversation-b");
  const admitted = performance.now();
  await queue.drainAfterAdmission();
  expect(performance.now() - admitted).toBeLessThan(1_000);
  expect(journal.ops.get("op-b2")!.status).toBe("delivered");

  /* Passes and watchdog ticks keep finding the hung send and never hand it over again. */
  for (let pass = 0; pass < 3; pass += 1) {
    time.advance(2_000);
    await queue.drain();
    await queue.tick();
  }
  expect(hung.inputs).toEqual(["op-a"]);
  expect(other.inputs).toEqual(["op-b", "op-b2"]);
  const record = progress.get("op-a")!;
  expect(record.waitReason).toBe("dispatching");
  expect(record.attempt).toBe(1);
  /* Past the stall bound the record says it is stalled, within ten seconds of the hang. */
  expect(record.stalledSince).not.toBeNull();
  expect(Date.parse(record.stalledSince!) - Date.parse(record.phaseSince)).toBeLessThanOrEqual(10_000);
});

test("a lost admission wake is replaced by the watchdog, and the record keeps the evidence", async () => {
  const time = clock();
  const journal = fakeJournal();
  const progress = new DeliveryProgressStore(null, time.now);
  const target = fakeHost(delivered);
  const queue = queueFor(journal.port({ progress }), { "conversation-a": target.engine },
    { passBudgetMs: 1_000, safetyPassMs: 5_000, now: time.now });
  /* Admitted, and the drain request that should follow never arrives. */
  journal.admit("op-lost", "conversation-a");
  time.advance(5_000);
  await queue.tick();
  expect(target.inputs).toEqual(["op-lost"]);
  const record = progress.get("op-lost")!;
  expect(record.terminal?.state).toBe("delivered");
  expect(record.wakeLostAt).not.toBeNull();
});

test("a lost turn-end wake costs one safety interval: the waiting send is delivered once by the watchdog", async () => {
  const time = clock();
  const journal = fakeJournal();
  const progress = new DeliveryProgressStore(null, time.now);
  let turn: string | null = "turn-running";
  const target = fakeHost(delivered, () => idleState(turn));
  const queue = queueFor(journal.port({ progress }), { "conversation-a": target.engine },
    { passBudgetMs: 1_000, safetyPassMs: 5_000, now: time.now });
  journal.admit("op-wait", "conversation-a");
  await queue.drain();
  expect(progress.get("op-wait")?.waitReason).toBe("awaiting-turn");
  expect(progress.get("op-wait")?.nextWakeAt).toBe(new Date(time.now() + 5_000).toISOString());

  /* The turn ends and the event that would have woken the queue is lost. */
  turn = null;
  time.advance(4_000);
  await queue.tick();
  expect(target.inputs).toEqual([]);
  time.advance(1_000);
  await queue.tick();
  expect(target.inputs).toEqual(["op-wait"]);
  time.advance(10_000);
  await queue.tick();
  expect(target.inputs).toEqual(["op-wait"]);
});

test("a lock delay on one conversation's delivery write leaves the other's pass alone and still produces one input", async () => {
  const journal = fakeJournal();
  const progress = new DeliveryProgressStore(null);
  const slow = fakeHost(delivered);
  const fast = fakeHost(delivered);
  journal.delayTransitions(async (operationId, status) => {
    if (operationId === "op-slow" && status === "delivering") await sleep(300);
  });
  journal.admit("op-slow", "conversation-slow");
  journal.admit("op-fast", "conversation-fast");
  const queue = queueFor(journal.port({ progress }), { "conversation-slow": slow.engine, "conversation-fast": fast.engine },
    { passBudgetMs: 50, safetyPassMs: 60_000 });
  const started = performance.now();
  await queue.drain();
  expect(performance.now() - started).toBeLessThan(250);
  expect(journal.ops.get("op-fast")!.status).toBe("delivered");
  expect(journal.ops.get("op-slow")!.status).toBe("queued");
  /* A pass during the delay leaves the slow conversation to the lane that owns it. */
  await queue.drain();
  await sleep(400);
  await queue.drain();
  expect(journal.ops.get("op-slow")!.status).toBe("delivered");
  expect(slow.inputs).toEqual(["op-slow"]);
  expect(fast.inputs).toEqual(["op-fast"]);
});

test("a late acknowledgement after the background deadline fenced the send is refused, delivers nothing twice, and frees the conversation", async () => {
  const time = clock();
  const journal = fakeJournal();
  const progress = new DeliveryProgressStore(null, time.now);
  const first = deferred<DeliveryReceipt>();
  let calls = 0;
  const target = fakeHost(() => (calls++ === 0 ? first.promise : delivered()));
  journal.admit("op-late", "conversation-a");
  const queue = queueFor(journal.port({ progress }), { "conversation-a": target.engine },
    { passBudgetMs: 30, stallMs: 1_000, safetyPassMs: 60_000, now: time.now });
  await queue.drain();
  expect(journal.ops.get("op-late")!.status).toBe("delivering");

  /* The settlement deadline ends it the way `fenceOperation` does: unverified. */
  journal.ops.get("op-late")!.status = "uncertain";
  time.advance(2_000);
  journal.admit("op-next", "conversation-a");
  await queue.drain();
  expect(journal.ops.get("op-next")!.status).toBe("delivered");

  /* The host's answer for the first send arrives after all of that. */
  first.resolve({ outcome: "turn-started", turnId: "turn-late" });
  await sleep(10);
  await queue.drain();
  expect(journal.ops.get("op-late")!.status).toBe("uncertain");
  expect(target.inputs).toEqual(["op-late", "op-next"]);
});

test("a lost acknowledgement of the delivered transition never brings the send back", async () => {
  const journal = fakeJournal();
  const progress = new DeliveryProgressStore(null);
  const target = fakeHost(delivered);
  journal.loseAcknowledgements((operationId, status) => operationId === "op-ack" && status === "delivered");
  journal.admit("op-ack", "conversation-a");
  const queue = queueFor(journal.port({ progress }), { "conversation-a": target.engine }, { safetyPassMs: 60_000 });
  await queue.drain();
  await queue.drain();
  await queue.drain();
  expect(journal.ops.get("op-ack")!.status).toBe("delivered");
  expect(target.inputs).toEqual(["op-ack"]);
  expect(progress.get("op-ack")?.terminal?.state).toBe("delivered");
});

test("across executor succession the original operation reaches the host at most once", async () => {
  for (const claimMoved of [false, true]) {
    const journal = fakeJournal();
    const answer = deferred<DeliveryReceipt>();
    const target = fakeHost(() => answer.promise);
    journal.admit("op-succession", "conversation-a");
    const predecessor = queueFor(journal.port(), { "conversation-a": target.engine }, { passBudgetMs: 20, safetyPassMs: 60_000 });
    await predecessor.drain();
    expect(journal.ops.get("op-succession")!.status).toBe("delivering");
    predecessor.retire();

    /* The successor reads the same journal. With the writer claim unchanged the
       row stays its owner's; with the claim moved it is ended unverified. */
    const successor = queueFor(journal.port({}, claimMoved ? "owner:2" : "owner:1"), { "conversation-a": target.engine },
      { passBudgetMs: 20, safetyPassMs: 60_000 });
    await successor.drain();
    await successor.drain();
    answer.resolve({ outcome: "turn-started", turnId: "turn-one" });
    await sleep(10);
    await successor.drain();
    expect(target.inputs).toEqual(["op-succession"]);
    expect(journal.ops.get("op-succession")!.status).toBe(claimMoved ? "uncertain" : "delivered");
  }
});

test("a crash at the transport and confirmation boundary leaves one input and an unverified answer, under any later executor", async () => {
  const journal = fakeJournal();
  const progress = new DeliveryProgressStore(null);
  /* The host took the input and the connection broke before it answered. */
  const target = fakeHost(async () => { throw new Error("structured host connection closed"); });
  journal.admit("op-boundary", "conversation-a");
  const first = queueFor(journal.port({ progress }), { "conversation-a": target.engine }, { safetyPassMs: 60_000 });
  await first.drain();
  expect(journal.ops.get("op-boundary")!.status).toBe("uncertain");
  const successor = queueFor(journal.port({ progress }), { "conversation-a": target.engine }, { safetyPassMs: 60_000 });
  await successor.drain();
  await successor.tick();
  expect(target.inputs).toEqual(["op-boundary"]);
  expect(progress.get("op-boundary")?.terminal?.state).toBe("uncertain");
});

test("an interrupt-active send whose interrupt makes no progress for thirty seconds reconciles under its original key", async () => {
  for (const evidence of [false, true]) {
    const time = clock();
    const journal = fakeJournal();
    const progress = new DeliveryProgressStore(null, time.now);
    let turn: string | null = "turn-stuck";
    const target = fakeHost(delivered, () => idleState(turn));
    const probes: string[] = [];
    journal.admit("op-interrupt", "conversation-a", "interrupt-active");
    const queue = queueFor(journal.port({
      progress,
      confirmedDelivery: async (operationId) => { probes.push(operationId); return evidence; },
    }), { "conversation-a": target.engine }, { passBudgetMs: 1_000, safetyPassMs: 60_000, interruptReconcileMs: 30_000, now: time.now });

    await queue.drain();
    expect(target.interrupts).toEqual(["turn-stuck"]);
    expect(progress.get("op-interrupt")?.waitReason).toBe("interrupting");
    time.advance(10_000);
    await queue.drain();
    expect(probes).toEqual([]);

    time.advance(21_000);
    await queue.drain();
    expect(probes).toEqual(["op-interrupt"]);
    if (evidence) {
      /* The host's own record shows it arrived: settled, nothing sent. */
      expect(journal.ops.get("op-interrupt")!.status).toBe("delivered");
      expect(target.inputs).toEqual([]);
      continue;
    }
    const record = progress.get("op-interrupt")!;
    expect(record.waitReason).toBe("interrupt-reconciling");
    expect(record.attempt).toBe(2);
    /* The next pass interrupts the running turn again, under the same operation. */
    await queue.drain();
    expect(target.interrupts).toEqual(["turn-stuck", "turn-stuck"]);
    expect(target.inputs).toEqual([]);
    turn = null;
    await queue.drain();
    await queue.drain();
    expect(target.inputs).toEqual(["op-interrupt"]);
    expect(journal.ops.get("op-interrupt")!.status).toBe("delivered");
  }
});

test("a lane whose host call does not answer is reconciled from host evidence and then let go", async () => {
  const time = clock();
  const journal = fakeJournal();
  const progress = new DeliveryProgressStore(null, time.now);
  let arrived = false;
  let calls = 0;
  const target = fakeHost(() => (calls++ === 0 ? never() : delivered()));
  journal.admit("op-held", "conversation-a");
  const queue = queueFor(journal.port({ progress, confirmedDelivery: async () => arrived }), { "conversation-a": target.engine },
    { passBudgetMs: 20, stallMs: 5_000, interruptReconcileMs: 30_000, safetyPassMs: 600_000, now: time.now });
  await queue.drain();
  time.advance(31_000);
  await queue.tick();
  /* No evidence yet: the send keeps its delivering fence and is not repeated. */
  expect(journal.ops.get("op-held")!.status).toBe("delivering");
  expect(progress.get("op-held")?.detail).toContain("no host evidence");
  arrived = true;
  time.advance(31_000);
  await queue.tick();
  expect(journal.ops.get("op-held")!.status).toBe("delivered");
  /* The conversation is free for its next message on the same executor. */
  journal.admit("op-after", "conversation-a");
  await queue.drain();
  await queue.drain();
  expect(target.inputs).toEqual(["op-held", "op-after"]);
  expect(journal.ops.get("op-after")!.status).toBe("delivered");
});

test("an operation that ended where this executor did not see it closes its open record on the next watchdog tick", async () => {
  const time = clock();
  const journal = fakeJournal();
  const progress = new DeliveryProgressStore(null, time.now);
  const target = fakeHost(delivered, () => idleState("turn-running"));
  journal.admit("op-discarded", "conversation-a");
  const queue = queueFor(journal.port({ progress }), { "conversation-a": target.engine }, { safetyPassMs: 600_000, now: time.now });
  await queue.drain();
  expect(progress.get("op-discarded")?.waitReason).toBe("awaiting-turn");
  /* The operator discards it from another surface. */
  journal.ops.get("op-discarded")!.status = "failed";
  journal.ops.get("op-discarded")!.reason = "delivery-discarded";
  await queue.drain();
  await queue.tick();
  await sleep(5);
  expect(progress.get("op-discarded")?.terminal).toMatchObject({ state: "failed", reason: "delivery-discarded" });
  expect(target.inputs).toEqual([]);
});

test("two executors that both read the operation as queued hand it over once", async () => {
  const journal = fakeJournal();
  const target = fakeHost(delivered);
  journal.admit("op-race", "conversation-a");
  /* Both executors reach the delivering write before either has made it. */
  let arrived = 0;
  const bothThere = deferred<void>();
  journal.delayTransitions(async (operationId, status) => {
    if (operationId !== "op-race" || status !== "delivering") return;
    arrived += 1;
    if (arrived === 2) bothThere.resolve();
    await bothThere.promise;
  });
  const first = queueFor(journal.port(), { "conversation-a": target.engine }, { safetyPassMs: 600_000 });
  const second = queueFor(journal.port(), { "conversation-a": target.engine }, { safetyPassMs: 600_000 });
  await Promise.allSettled([first.drain(), second.drain()]);
  await first.drain().catch(() => undefined);
  await second.drain().catch(() => undefined);
  expect(target.inputs).toEqual(["op-race"]);
  expect(journal.ops.get("op-race")!.status).toBe("delivered");
});
