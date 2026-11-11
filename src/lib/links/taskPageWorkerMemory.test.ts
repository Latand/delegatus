import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-worker-memory-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const { roleMemoryCollection } = await import("@/lib/memory/roleStore");
const { TaskPageWorker, taskPageWorkerRssLimitBytes } = await import("./taskPageWorker");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const LESSON = "Keep the amber ledger readable for every later reader of the fixture";
function seed() {
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({ kind: "rule", id: "r_00000000000000aa", scope: "machine", rule: LESSON, why: "", state: "active", hints: [],
    source: { project: "worker-memory-fixture", pipelineId: "p", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "c" },
    createdAt: "2026-10-11T00:00:00.000Z", changedAt: "2026-10-11T00:00:00.000Z" }));
}

test("a worker over its memory limit after a job is retired and the next job gets a fresh one", async () => {
  seed();
  const pids: number[] = [];
  let resident = 64 * 1024 * 1024;
  const worker = new TaskPageWorker({ timeoutMs: 30_000, residentBytes: pid => { pids.push(pid); return resident; } });
  try {
    expect((await worker.privacy({ kind: "filter", value: `x ${LESSON} y` })).value).toBe("x [learned rule] y");
    expect((await worker.privacy({ kind: "filter", value: LESSON })).value).toBe("[learned rule]");
    expect(new Set(pids).size).toBe(1);
    expect(worker.retirements).toBe(0);
    resident = taskPageWorkerRssLimitBytes() + 1;
    // The job that finds the worker too large is still answered.
    expect((await worker.privacy({ kind: "filter", value: LESSON })).value).toBe("[learned rule]");
    expect(worker.retirements).toBe(1);
    resident = 64 * 1024 * 1024;
    expect((await worker.privacy({ kind: "filter", value: LESSON })).value).toBe("[learned rule]");
    expect(new Set(pids).size).toBe(2);
    expect(worker.retirements).toBe(1);
  } finally { await worker.shutdown(); }
  expect(taskPageWorkerRssLimitBytes({ LLV_TASK_PAGE_WORKER_RSS_MB: "256" })).toBe(256 * 1024 * 1024);
  expect(taskPageWorkerRssLimitBytes({ LLV_TASK_PAGE_WORKER_RSS_MB: "nonsense" })).toBe(1536 * 1024 * 1024);
}, 60_000);
