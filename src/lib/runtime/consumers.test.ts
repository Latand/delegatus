import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { RuntimeHost } from "@/runtime-host/host";
import { RuntimeJournal } from "@/runtime-host/journal";

import { consumeRuntimeEvent, RuntimeConsumerDeferredError, type RuntimeConsumerPorts } from "./consumers";
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

function runtimeEvent(kind: string, payload: Record<string, unknown>): RuntimeEvent {
  return {
    schemaVersion: 1, seq: 1, eventId: "event-1", scope: { type: "session", id: "conversation_c" }, revision: 1,
    kind, occurredAt: "2026-10-14T12:00:00.000Z", recordedAt: "2026-10-14T12:00:00.000Z",
    producer: { kind: "codex-app-server" } as never, causationId: null, correlationId: null, payload,
  };
}

test("every port's hot-state refusal is deferred under its own label; any other failure passes through (#2867)", async () => {
  const fenced = (): never => { throw new FileTransactionBusyError("hot state migration is waiting for release promotion"); };
  const ports: RuntimeConsumerPorts = { flowReady: fenced, workflowStageCompleted: fenced, taskDeliveryAcknowledged: fenced, spawnTurnEnded: fenced };
  const cases = [
    ["flow readiness", runtimeEvent("turn-ended", { flowId: "flow-1", readyNote: "REVIEW_READY: done" })],
    ["workflow stage completion", runtimeEvent("workflow.stage.completed", { workflowId: "workflow-1", stage: 0 })],
    ["task delivery", runtimeEvent("task.delivery.acked", { taskId: "task-1", assignmentId: "assignment-1" })],
    ["completion notice", runtimeEvent("turn-ended", { conversationId: "conversation_c", turnId: "t1", outcome: "completed" })],
  ] as const;
  for (const [label, event] of cases) {
    const error = await consumeRuntimeEvent(event, ports).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeConsumerDeferredError);
    expect((error as Error).message).toBe(`${label} deferred: hot state migration is waiting for release promotion`);
    expect((error as Error).cause).toBeInstanceOf(FileTransactionBusyError);
  }
  const poison = new Error("the stored flow is unreadable");
  const failing = (): never => { throw poison; };
  const failingPorts: RuntimeConsumerPorts = { flowReady: failing, workflowStageCompleted: failing, taskDeliveryAcknowledged: failing, spawnTurnEnded: failing };
  for (const [, event] of cases) {
    expect(await consumeRuntimeEvent(event, failingPorts).then(() => null, (caught: unknown) => caught)).toBe(poison);
  }
});

test("a fenced flow turn ahead of a fenced notice keeps the retry armed until both land, with no further call (#2867)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-consumer-retry-"));
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"));
  let fenced = true;
  let flowAttempts = 0;
  const notices: string[] = [];
  const refuse = () => { throw new FileTransactionBusyError("hot state migration is waiting for release promotion"); };
  const host = new RuntimeHost(journal, {
    flowReady: () => { flowAttempts += 1; if (fenced) refuse(); },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
    spawnTurnEnded: (turn) => { if (fenced) refuse(); notices.push(turn.turnId); },
  }, undefined, undefined, undefined, undefined, undefined, 50);
  const append = (scope: string, turn: string, payload: Record<string, unknown>) => host.handle({ id: turn, method: "append", params: { event: {
    scope: runtimeScope("session", scope), kind: "turn-ended",
    payload: { conversationId: scope, turnId: turn, outcome: "completed", ...payload },
    producer: { kind: "codex-app-server", eventKey: `engine-host:fixture:${turn}` },
  } } });
  try {
    expect((await append("flow-worker", "flow-turn", { flowId: "flow-held", readyNote: "REVIEW_READY: done" })).ok).toBe(true);
    expect((await append("conversation_c", "child-turn", {})).ok).toBe(true);
    /* The fence outlasts the first timed retry, which meets the flow turn
       first. */
    const outlast = Date.now() + 2_000;
    while (flowAttempts < 3 && Date.now() < outlast) await Bun.sleep(10);
    expect(flowAttempts).toBeGreaterThanOrEqual(2);
    fenced = false;
    /* Twenty retry intervals without a command, an append or a restart. */
    const deadline = Date.now() + 1_000;
    while (journal.unconsumedEvents("orchestration").length > 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(notices).toEqual(["child-turn"]);
    expect(journal.unconsumedEvents("orchestration").map((event) => event.payload.turnId)).toEqual([]);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
