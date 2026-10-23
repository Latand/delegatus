import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFlows, saveFlows } from "@/lib/flows/store";

import type { Flow } from "@/lib/flows/types";

import { advanceFlowFromRuntime, createServerRuntimeConsumers } from "./serverConsumers";

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

test("terminal readiness refuses without mutating the retained flow", () => {
  const value = flow();
  const before = JSON.stringify(value);
  expect(() => advanceFlowFromRuntime(value, "REVIEW_READY: contract fixed")).toThrow("FLOW_RETIRED");
  expect(JSON.stringify(value)).toBe(before);
});

test("retired runtime callbacks refuse immediately while the state database has another writer", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-consumer-lock-"));
  process.env.LLV_STATE_DIR = root;
  let db: Database | undefined;
  try {
    saveFlows([flow()]);
    const before = JSON.stringify(loadFlows());
    db = new Database(path.join(root, "state.sqlite"));
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    await expect(createServerRuntimeConsumers().flowReady("flow-one", "REVIEW_READY: durable")).rejects.toMatchObject({ code: "FLOW_RETIRED" });
    await expect(createServerRuntimeConsumers().workflowStageCompleted("workflow-one", 0)).rejects.toMatchObject({ code: "FLOW_RETIRED" });
    expect(JSON.stringify(loadFlows())).toBe(before);
    db.exec("ROLLBACK");
  } finally {
    db?.close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
