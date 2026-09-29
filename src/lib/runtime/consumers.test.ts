import { expect, test } from "bun:test";

import { consumeRuntimeEvent } from "./consumers";
import { axesForEvent, runtimeScope, type RuntimeEvent, type RuntimeSessionAxes } from "./contracts";

test("a hosted turn advances a flow without scanner polling", async () => {
  const calls: string[] = [];
  const ports = {
    flowReady: (id: string, note: string | null) => { calls.push(`${id}:${note}`); },
    workflowStageCompleted: () => { throw new Error("unexpected workflow call"); },
    taskDeliveryAcknowledged: () => { throw new Error("unexpected task call"); },
  };
  const event: RuntimeEvent = {
    schemaVersion: 1,
    seq: 4,
    eventId: "evt-4",
    revision: 3,
    scope: runtimeScope("session", "implementer"),
    kind: "turn-ended",
    payload: { flowId: "flow-1", readyNote: "REVIEW_READY: done" },
    occurredAt: "2026-07-10T00:00:00.000Z",
    recordedAt: "2026-07-10T00:00:00.000Z",
    producer: { kind: "test" },
    causationId: null,
    correlationId: null,
  };
  await consumeRuntimeEvent(event, ports);
  expect(calls).toEqual(["flow-1:REVIEW_READY: done"]);
});

test("a settled turn outside any flow reaches the completion-notice port, a flow turn only the flow (spawn-completion-notice §2)", async () => {
  const seen: unknown[] = [];
  const flowReady: string[] = [];
  const ports = {
    flowReady: (flowId: string) => { flowReady.push(flowId); },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
    spawnTurnEnded: (turn: unknown) => { seen.push(turn); },
  };
  const event = (payload: Record<string, unknown>): RuntimeEvent => ({
    schemaVersion: 1, seq: 1, eventId: "event-1", scope: { type: "session", id: "conversation_c" }, revision: 1,
    kind: "turn-ended", occurredAt: "2026-09-29T12:00:00.000Z", recordedAt: "2026-09-29T12:00:00.000Z",
    producer: { kind: "claude-stream-broker" } as never, causationId: null, correlationId: null, payload,
  });
  await consumeRuntimeEvent(event({ conversationId: "conversation_c", turnId: "t1", outcome: "error", turnStartedAt: "2026-09-29T11:59:00.000Z" }), ports);
  await consumeRuntimeEvent(event({ conversationId: "conversation_c", turnId: "t2", outcome: "completed", flowId: "flow-1" }), ports);
  await consumeRuntimeEvent(event({ conversationId: "conversation_c", turnId: "t3", outcome: "bogus" }), ports);
  expect(seen).toEqual([{ conversationId: "conversation_c", turnId: "t1", outcome: "error", startedAt: "2026-09-29T11:59:00.000Z", endedAt: "2026-09-29T12:00:00.000Z" }]);
  expect(flowReady).toEqual(["flow-1"]);
});

test("issue 51 axes keep an active turn running through prose and item completion", () => {
  const initial: RuntimeSessionAxes = { host: "hosted", turn: "running", attention: "none", freshness: "structured" };
  const prose = axesForEvent(initial, { kind: "item.completed", payload: { text: "REVIEW_READY: still running tools" } });
  const tool = axesForEvent(prose, { kind: "item.completed", payload: { itemType: "commandExecution" } });
  const terminal = axesForEvent(tool, { kind: "turn.completed", payload: {} });
  const disconnected = axesForEvent(tool, { kind: "host.disconnected", payload: {} });
  expect(prose.turn).toBe("running");
  expect(tool.turn).toBe("running");
  expect(terminal.turn).toBe("idle");
  expect(disconnected).toMatchObject({ host: "recovering", turn: "unknown", freshness: "replayed" });
});
