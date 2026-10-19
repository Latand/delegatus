import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFlows, saveFlowRows, saveFlows } from "@/lib/flows/store";

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

test("terminal readiness advances a flow once under server ownership", () => {
  const value = flow();
  expect(advanceFlowFromRuntime(value, "REVIEW_READY: contract fixed")).toBe(true);
  expect(value).toMatchObject({
    state: "spawn_pending",
    rounds: [{ n: 1, triggeredBy: "marker", readyNote: "contract fixed" }],
  });
  expect(advanceFlowFromRuntime(value, "REVIEW_READY: contract fixed")).toBe(false);
  expect(value.rounds).toHaveLength(1);
});

test("the runtime consumer yields behind a writer and acknowledges only its durable projection", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-consumer-lock-"));
  process.env.LLV_STATE_DIR = root;
  let db: Database | undefined;
  let pending: Promise<unknown> | undefined;
  let last = performance.now(), maxGap = 0;
  const probe = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
  try {
    saveFlows([flow()]);
    db = new Database(path.join(root, "state.sqlite"));
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    last = performance.now(); maxGap = 0;
    let acknowledged = false;
    pending = Promise.resolve(createServerRuntimeConsumers().flowReady("flow-one", "REVIEW_READY: durable"))
      .then(value => { acknowledged = true; return value; });
    void pending.catch(() => {});
    // The contender and release share one event loop.
    await Bun.sleep(100);
    expect(acknowledged).toBe(false);
    expect(loadFlows()[0]!.state).toBe("waiting_ready");
    const updated = flow(); updated.roundLimit = 7;
    db.exec("COMMIT");
    saveFlowRows([updated]);
    await pending;
    await Bun.sleep(10);
    expect(loadFlows()[0]!.state).toBe("spawn_pending");
    expect(loadFlows()[0]!.roundLimit).toBe(7);
    expect(maxGap).toBeLessThanOrEqual(50);
  } finally {
    clearInterval(probe); db?.close();
    await pending?.catch(() => {});
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
