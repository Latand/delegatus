import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-worker-memory-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const { roleMemoryCollection } = await import("@/lib/memory/roleStore");
const { TaskPageWorker } = await import("./taskPageWorker");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const LESSON = "Keep the amber ledger readable for every later reader of the fixture";
roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({ kind: "rule", id: "r_00000000000000aa", scope: "machine", rule: LESSON, why: "", state: "active", hints: [],
  source: { project: "worker-memory-fixture", pipelineId: "p", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "c" },
  createdAt: "2026-10-11T00:00:00.000Z", changedAt: "2026-10-11T00:00:00.000Z" }));
const filter = (worker: InstanceType<typeof TaskPageWorker>, index: number) => worker.privacy({ kind: "filter", value: `job ${index}: ${LESSON}` });
/** Every worker process is over a limit of one megabyte, at any age. */
const overLimit = { LLV_RESIDENT_WORKER_RSS_LIMIT_MB: "1", LLV_RESIDENT_WORKER_MEMORY_MIN_AGE_SEC: "0" };

test("a worker under its memory limit keeps serving from one process", async () => {
  const worker = new TaskPageWorker({ timeoutMs: 30_000 });
  try {
    for (let index = 0; index < 3; index++) expect((await filter(worker, index)).value).toBe(`job ${index}: [learned rule]`);
    expect(worker.starts).toBe(1);
    expect(worker.memoryRetirements).toBe(0);
  } finally { await worker.shutdown(); }
}, 60_000);

test("a worker over its memory limit is retired after its job, and jobs sent back to back are all answered", async () => {
  const worker = new TaskPageWorker({ timeoutMs: 30_000, env: overLimit });
  try {
    // Six jobs are queued at once: each next one is already waiting when the worker before it is retired.
    const answers = await Promise.all(Array.from({ length: 6 }, (_, index) => filter(worker, index)));
    expect(answers.map(answer => answer.value)).toEqual(Array.from({ length: 6 }, (_, index) => `job ${index}: [learned rule]`));
    expect(worker.starts).toBe(6);
    expect(worker.memoryRetirements).toBe(6);
    // A job sent the moment the last answer arrives still gets a fresh process and an answer.
    const first = filter(worker, 6);
    const second = first.then(() => filter(worker, 7));
    expect((await first).value).toBe("job 6: [learned rule]");
    expect((await second).value).toBe("job 7: [learned rule]");
    expect(worker.starts).toBe(8);
  } finally { await worker.shutdown(); }
}, 120_000);

test("a young worker is not retired for memory, so a steady size above the limit cannot restart it on every job", async () => {
  const worker = new TaskPageWorker({ timeoutMs: 30_000, env: { LLV_RESIDENT_WORKER_RSS_LIMIT_MB: "1" } });
  try {
    for (let index = 0; index < 3; index++) expect((await filter(worker, index)).value).toBe(`job ${index}: [learned rule]`);
    expect(worker.starts).toBe(1);
    expect(worker.memoryRetirements).toBe(0);
  } finally { await worker.shutdown(); }
}, 60_000);

test("a job that adds much resident memory is named in the journal by kind and size alone", async () => {
  const worker = new TaskPageWorker({ timeoutMs: 30_000, memoryStepBytes: Number.NEGATIVE_INFINITY });
  const log = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await filter(worker, 0);
    await filter(worker, 1);
    const lines = log.mock.calls.flat().filter(line => String(line).startsWith("[task-page-worker] memory step "));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(String(lines[0]).slice("[task-page-worker] memory step ".length))).toEqual({ kind: "filter", addedBytes: expect.any(Number), rssBytes: expect.any(Number), served: 2 });
    expect(lines.join("")).not.toContain("amber");
  } finally { log.mockRestore(); await worker.shutdown(); }
}, 60_000);
