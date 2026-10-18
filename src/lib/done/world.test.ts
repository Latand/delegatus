import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BoardTask } from "@/lib/tasks/types";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "done-world-"));
const prior = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = root;
const { saveTasks } = await import("@/lib/tasks/store");
const { productionDoneWorld } = await import("./world");
const reviews = await import("@/lib/prototypeReview/read");
const { readPrototypeReviews } = reviews;
afterAll(() => {
  if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
  fs.rmSync(root, { recursive: true, force: true });
});

test("empty round tiers do no dismissal reads as unrelated finished tasks grow; real rounds stay equivalent", () => {
  const task = (id: string): BoardTask => ({ id, project: "fixture", status: "assigned", text: id, assignments: [], placement: "unplaced",
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" });
  for (const count of [10, 100]) {
    const tasks = Array.from({ length: count }, (_, n) => task(`empty-${n}`));
    saveTasks(tasks);
    const world = productionDoneWorld(); world.tasks();
    const read = spyOn(reviews, "readPrototypeReviews");
    try {
      for (const task of tasks) expect(world.rounds(task.id)).toEqual([]);
      expect(read).toHaveBeenCalledTimes(0);
    } finally { read.mockRestore(); }
  }
  const reviewed = task("reviewed");
  const round: PrototypeReviewRound = { id: "review-fixture", title: "Review", taskId: reviewed.id,
    project: "fixture", createdAt: reviewed.createdAt, source: { conversationId: null },
    publicationKey: "fixture", inputDigest: "fixture", variants: [] };
  reviewed.prototypeReviews = [round];
  const replica = task("replica");
  const read = readPrototypeReviews(reviewed);
  replica.prototypeReviewReplica = { summary: read.summary!, rounds: read.rounds };
  saveTasks([reviewed, replica]);
  const world = productionDoneWorld();
  const first = world.rounds(reviewed.id);
  const repeatReads = spyOn(reviews, "readPrototypeReviews");
  try {
    expect(world.rounds(reviewed.id)).toBe(first);
    expect(repeatReads).toHaveBeenCalledTimes(0);
  } finally { repeatReads.mockRestore(); }
  expect(first).toEqual(readPrototypeReviews(reviewed).rounds);
  expect(world.rounds(replica.id)).toEqual(readPrototypeReviews(replica).rounds);
  const many = Array.from({ length: 70 }, (_, n) => ({ ...task(`round-task-${n}`),
    prototypeReviews: [{ ...round, id: `round-${n}`, taskId: `round-task-${n}` }] }));
  saveTasks(many);
  const bounded = productionDoneWorld();
  for (const task of many) bounded.rounds(task.id);
  const reread = spyOn(reviews, "readPrototypeReviews");
  try {
    bounded.rounds(many.at(-1)!.id);
    expect(reread).toHaveBeenCalledTimes(0);
    bounded.rounds(many[0]!.id);
    expect(reread).toHaveBeenCalledTimes(1);
  } finally { reread.mockRestore(); }
  const updated = many.map((task, n) => n ? task : { ...task,
    prototypeReviews: [{ ...task.prototypeReviews[0]!, title: "New decision" }] });
  saveTasks(updated);
  expect(bounded.rounds(many[0]!.id)[0]!.title).toBe("Review");
  expect(productionDoneWorld().rounds(many[0]!.id)[0]!.title).toBe("New decision");
  const refused = productionDoneWorld();
  const refusal = spyOn(reviews, "readPrototypeReviews").mockImplementation(() => { throw Error("fixture refusal"); });
  try {
    expect(refused.rounds(many[0]!.id)).toEqual([]);
    expect(refused.rounds(many[0]!.id)).toEqual([]);
    expect(refusal).toHaveBeenCalledTimes(1);
  } finally { refusal.mockRestore(); }
  expect(productionDoneWorld().rounds(many[0]!.id)[0]!.title).toBe("New decision");
});


test.each([false, true])("done.sweep appears in active and completed gap records across a refused async port (throw: %s)", async fails => {
  const { viewerLoopMonitor, createViewerLoopMonitor } = await import("@/lib/viewerLoopMonitor");
  const { createPerformanceSpans } = await import("@/lib/performanceSpans");
  const { runDoneSweepOnce } = await import("./sweep");
  let at = 0;
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, createPerformanceSpans(() => at));
  const run = spyOn(viewerLoopMonitor, "run").mockImplementation((name, work) => monitor.run(name, work));
  try {
    const sweep = runDoneSweepOnce({ ownsTraffic: async () => {
      await Promise.resolve(); at += 1000; monitor.tick();
      if (fails) throw Error("fixture refusal");
      return false;
    } });
    if (fails) await expect(sweep).rejects.toThrow("fixture refusal");
    else expect(await sweep).toBe(false);
    at += 1000; monitor.tick();
    const gaps = lines.map(line => JSON.parse(line.slice("[viewer loop-gap] ".length)));
    expect(gaps[0].operations[0]).toMatchObject({ name: "done.sweep", durationMs: 1000, completed: false, count: 1 });
    expect(gaps[1].operations[0]).toMatchObject({ name: "done.sweep", durationMs: 1000, completed: true, count: 1 });
  } finally { run.mockRestore(); monitor.stop(); }
});
