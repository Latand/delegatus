import { expect, test } from "bun:test";

import type { RuntimeTransitionDetails } from "./contracts";
import type { DeliveryReceipt, EngineHost, HostState, QueueEntry, RuntimeEvent } from "./engineHost";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";

/*
 * Interrupt-and-resend (docs/design/copilot-engine.md 3.4, the operator's
 * correction of 2026-09-22): a host with no steer that declares
 * `steerFallback: "interrupt"` takes a message meant for its running turn by
 * interrupting that turn and starting the next one. The receipt says
 * `interrupt-then-turn-started`; it is never `steered`.
 */

function state(overrides: Partial<HostState> = {}): HostState {
  return {
    status: "idle",
    sessionKey: "copilot-session",
    endpoint: "test:host",
    pid: 1,
    processStartIdentity: "1",
    eventCursor: 0,
    protocolVersion: "1.0.87",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
    ...overrides,
  };
}

/** A Copilot-shaped host: no steer, interrupt fallback, one running turn. */
function copilotHost(actions: string[]): EngineHost & { running: string | null } {
  const target = {
    running: "copilot:1-turn" as string | null,
    supportsSteer: false,
    steerFallback: "interrupt" as const,
    attach: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {} }),
    async send(entry: QueueEntry): Promise<DeliveryReceipt> {
      if (target.running) {
        actions.push(`send-refused:${String(entry.text)}`);
        return { outcome: "rejected", reason: "stale-turn" };
      }
      actions.push(`send:${String(entry.text)}:${String(entry.expectedTurnId)}`);
      target.running = "copilot:2-turn";
      return { outcome: "turn-started", turnId: "copilot:2-turn" };
    },
    async interrupt(turnId: string): Promise<void> {
      actions.push(`interrupt:${turnId}`);
      if (target.running === turnId) target.running = null;
    },
    answer: async () => {},
    health: async () => target.running
      ? state({ status: "active", activeTurnRef: target.running })
      : state(),
    release: async () => {},
  };
  return target;
}

type Transition = [string, string, RuntimeTransitionDetails | undefined];

async function drainOne(
  target: EngineHost,
  effect: { kind: "runtime.send" | "runtime.steer"; payload: Record<string, unknown> },
): Promise<Transition[]> {
  const transitions: Transition[] = [];
  let pending = true;
  const queue = new StructuredDeliveryQueue({
    effects: async () => pending ? [{ id: `effect:${String(effect.payload.operationId)}`, eventSeq: 1, ...effect }] : [],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details]);
      if (status === "delivered" || status === "failed") pending = false;
    },
  }, () => target);
  await queue.drain();
  return transitions;
}

test.each([
  ["a steer", { kind: "runtime.steer" as const, payload: { operationId: "op-steer", conversationId: "copilot-conversation", text: "change course", turnId: "copilot:1-turn" } }],
  ["a steer-if-active send", { kind: "runtime.send" as const, payload: { operationId: "op-steer-if-active", conversationId: "copilot-conversation", text: "change course", policy: "steer-if-active" } }],
  ["an interrupt-active send", { kind: "runtime.send" as const, payload: { operationId: "op-interrupt-active", conversationId: "copilot-conversation", text: "change course", policy: "interrupt-active" } }],
])("%s to a running Copilot turn interrupts it and starts the next turn", async (_label, effect) => {
  const actions: string[] = [];
  const target = copilotHost(actions);
  const transitions = await drainOne(target, effect);
  /* The cancel comes first and the message is sent once, as a new turn on
     an idle host: nothing lands on top of the running turn. */
  expect(actions).toEqual(["interrupt:copilot:1-turn", "send:change course:null"]);
  const settled = transitions.at(-1)!;
  expect(settled[1]).toBe("delivered");
  expect(settled[2]).toEqual({
    turnId: "copilot:2-turn",
    delivery: "interrupt-then-turn-started",
    interruptedTurnId: "copilot:1-turn",
  });
  expect(transitions.map(([, status]) => status)).not.toContain("steered");
  expect(transitions.map(([, status]) => status)).not.toContain("failed");
});

test("a steer for a Copilot turn that already ended starts a turn with nothing to interrupt", async () => {
  const actions: string[] = [];
  const target = copilotHost(actions);
  target.running = null;
  const transitions = await drainOne(target, { kind: "runtime.steer", payload: {
    operationId: "op-late-steer", conversationId: "copilot-conversation", text: "one more thing", turnId: "copilot:1-turn",
  } });
  expect(actions).toEqual(["send:one more thing:null"]);
  expect(transitions.at(-1)).toEqual(["op-late-steer", "delivered", { turnId: "copilot:2-turn" }]);
});

test("a queue-policy send waits for the running Copilot turn to finish", async () => {
  const actions: string[] = [];
  const target = copilotHost(actions);
  const transitions: Transition[] = [];
  let pending = true;
  const queue = new StructuredDeliveryQueue({
    effects: async () => pending ? [{ id: "effect:op-queue", eventSeq: 1, kind: "runtime.send", payload: {
      operationId: "op-queue", conversationId: "copilot-conversation", text: "after this turn", policy: "queue",
    } }] : [],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details]);
      if (status === "delivered") pending = false;
    },
  }, () => target);
  await queue.drain();
  expect(actions).toEqual([]);
  expect(transitions).toEqual([]);
  /* The turn ends on its own; the queued message goes out as a plain turn. */
  target.running = null;
  await queue.drain();
  expect(actions).toEqual(["send:after this turn:null"]);
  expect(transitions.at(-1)).toEqual(["op-queue", "delivered", { turnId: "copilot:2-turn" }]);
});

test("an interrupt past its bound puts the message back instead of sending on top of the turn", async () => {
  const actions: string[] = [];
  const target = copilotHost(actions);
  target.interrupt = async (turnId) => {
    actions.push(`interrupt:${turnId}`);
    throw new Error("Copilot turn did not stop within 10000ms of session/cancel");
  };
  const transitions: Transition[] = [];
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{ id: "effect:op-stuck", eventSeq: 1, kind: "runtime.steer", payload: {
      operationId: "op-stuck", conversationId: "copilot-conversation", text: "change course", turnId: "copilot:1-turn",
    } }],
    transition: async (operationId, status, details) => { transitions.push([operationId, status, details]); },
  }, () => target);
  await queue.drain();
  expect(actions).toEqual(["interrupt:copilot:1-turn"]);
  expect(transitions.map(([, status]) => status)).toEqual(["delivering", "queued"]);
  expect(transitions.at(-1)?.[2]?.reason).toBe("interrupt-auto-retry");
});

test("the Claude broker's steering refusal is unchanged: no fallback, no write, no interrupt", async () => {
  const actions: string[] = [];
  const broker: EngineHost = {
    ...copilotHost(actions),
    supportsSteer: false,
    steerFallback: undefined,
    health: async () => state({ status: "active", activeTurnRef: "incumbent" }),
    send: async () => { actions.push("send"); return { outcome: "queued-next-turn", turnId: "incumbent" }; },
    interrupt: async () => { actions.push("interrupt"); },
  };
  const transitions = await drainOne(broker, { kind: "runtime.send", payload: {
    operationId: "op-broker", conversationId: "conversation-broker", text: "supplementary", policy: "steer-if-active", turnId: "incumbent",
  } });
  expect(actions).toEqual([]);
  expect(transitions.map(([, status, details]) => `${status}:${details?.reason}`)).toEqual(["failed:unsupported-steering"]);
});

test("the interrupt route is durable before the interrupt is issued", async () => {
  const actions: string[] = [];
  const target = copilotHost(actions);
  const interrupt = target.interrupt.bind(target);
  const transitions: Transition[] = [];
  target.interrupt = async (turnId) => {
    /* What a successor executor would read if this one died right here. */
    expect(transitions.at(-1)).toEqual(["op-durable", "delivering", expect.objectContaining({
      delivery: "interrupt-then-turn-started",
      interruptedTurnId: "copilot:1-turn",
    })]);
    await interrupt(turnId);
  };
  let pending = true;
  const queue = new StructuredDeliveryQueue({
    effects: async () => pending ? [{ id: "effect:op-durable", eventSeq: 1, kind: "runtime.send", payload: {
      operationId: "op-durable", conversationId: "copilot-conversation", text: "change course", policy: "interrupt-active",
    } }] : [],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details]);
      if (status === "delivered") pending = false;
    },
  }, () => target);
  await queue.drain();
  expect(actions).toEqual(["interrupt:copilot:1-turn", "send:change course:null"]);
  expect(transitions.at(-1)?.[2]).toMatchObject({ delivery: "interrupt-then-turn-started", interruptedTurnId: "copilot:1-turn" });
});

test("a successor executor reports the interrupt an earlier executor recorded", async () => {
  const actions: string[] = [];
  const target = copilotHost(actions);
  /* The earlier executor interrupted the turn and the message went back to
     the queue; this executor finds the host idle and only has to send. */
  target.running = null;
  const transitions: Transition[] = [];
  let pending = true;
  const queue = new StructuredDeliveryQueue({
    effects: async () => pending ? [{ id: "effect:op-successor", eventSeq: 1, kind: "runtime.send", payload: {
      operationId: "op-successor", conversationId: "copilot-conversation", text: "change course", policy: "interrupt-active",
    } }] : [],
    status: async () => ({
      status: "queued",
      revision: 3,
      reason: "interrupt-requested",
      delivery: "interrupt-then-turn-started",
      interruptedTurnId: "copilot:1-turn",
    }),
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details]);
      if (status === "delivered") pending = false;
    },
  }, () => target);
  await queue.drain();
  expect(actions).toEqual(["send:change course:null"]);
  expect(transitions.at(-1)).toEqual(["op-successor", "delivered", {
    turnId: "copilot:2-turn",
    delivery: "interrupt-then-turn-started",
    interruptedTurnId: "copilot:1-turn",
  }]);
});

test("an interrupt that failed withdraws the route it recorded", async () => {
  const actions: string[] = [];
  const target = copilotHost(actions);
  target.interrupt = async () => { throw new Error("Copilot turn did not stop within 10000ms of session/cancel"); };
  const transitions: Transition[] = [];
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{ id: "effect:op-withdrawn", eventSeq: 1, kind: "runtime.send", payload: {
      operationId: "op-withdrawn", conversationId: "copilot-conversation", text: "change course", policy: "interrupt-active",
    } }],
    transition: async (operationId, status, details) => { transitions.push([operationId, status, details]); },
  }, () => target);
  await queue.drain();
  expect(transitions.at(-1)).toEqual(["op-withdrawn", "queued", { reason: "interrupt-auto-retry", delivery: null, interruptedTurnId: null }]);
});

test("a Codex-shaped host's interrupt-active send carries no route", async () => {
  const actions: string[] = [];
  const codex: EngineHost & { running: string | null } = { ...copilotHost(actions), supportsSteer: true, steerFallback: undefined };
  const transitions = await drainOne(codex, { kind: "runtime.send", payload: {
    operationId: "op-codex", conversationId: "codex-conversation", text: "change course", policy: "interrupt-active",
  } });
  expect(actions).toEqual(["interrupt:copilot:1-turn", "send:change course:null"]);
  for (const [, , details] of transitions) {
    expect(details?.delivery).toBeUndefined();
    expect(details?.interruptedTurnId).toBeUndefined();
  }
  expect(transitions.at(-1)).toEqual(["op-codex", "delivered", { turnId: "copilot:2-turn" }]);
});
