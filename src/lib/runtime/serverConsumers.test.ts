import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFlows, saveFlows } from "@/lib/flows/store";

import type { Flow } from "@/lib/flows/types";

import { consumeRuntimeEvent } from "./consumers";
import { runtimeScope, type RuntimeEvent } from "./contracts";
import { createServerRuntimeConsumers } from "./serverConsumers";

function flow(): Flow {
  return {
    id: "flow-one",
    template: "implement-review-loop",
    project: "project",
    cwd: "/repo",
    implementerPath: "/sessions/implementer.jsonl",
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "abc123",
    baseMode: "head",
    mode: "manual",
    reviewerMode: "headless",
    roundLimit: 1,
    state: "waiting_ready",
    pausedState: null,
    stateDetail: null,
    rounds: [],
    createdAt: "2026-07-10T00:00:00.000Z",
    closedAt: null,
  };
}

test("stored flow and workflow events reach no writer and leave the stored flow untouched", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-consumer-retired-"));
  process.env.LLV_STATE_DIR = root;
  try {
    saveFlows([flow()]);
    const before = JSON.stringify(loadFlows());
    const consumers = createServerRuntimeConsumers();
    expect(Object.keys(consumers).sort()).toEqual(["spawnTurnEnded", "taskDeliveryAcknowledged"]);
    const event = (kind: string, scope: RuntimeEvent["scope"], payload: Record<string, unknown>): RuntimeEvent => ({
      schemaVersion: 1, seq: 1, eventId: `event-${kind}`, revision: 1, scope, kind, payload,
      occurredAt: "2026-07-10T00:00:00.000Z", recordedAt: "2026-07-10T00:00:00.000Z",
      producer: { kind: "test" }, causationId: null, correlationId: null,
    });
    for (const stored of [
      event("flow.ready", runtimeScope("flow", "flow-one"), { flowId: "flow-one", readyNote: "REVIEW_READY: durable" }),
      event("turn-ended", runtimeScope("session", "implementer"), { flowId: "flow-one", readyNote: "REVIEW_READY: durable", conversationId: "conversation_c", turnId: "t1", outcome: "completed" }),
      event("workflow.stage.completed", runtimeScope("workflow", "workflow-one"), { workflowId: "workflow-one", stage: 0 }),
    ]) {
      expect(await consumeRuntimeEvent(stored, consumers)).toEqual([]);
    }
    expect(JSON.stringify(loadFlows())).toBe(before);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
