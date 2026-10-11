import { expect, test } from "bun:test";

import { createFilesProjectionQueue, FilesProjectionQueueError } from "./projectionQueue";

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, release };
}

test("builds run one at a time in arrival order, with queue wait reported apart from build time", async () => {
  let clock = 0;
  const queue = createFilesProjectionQueue({ maxDepth: 4, maxWaitMs: 1_000, now: () => clock });
  const order: string[] = [];
  const first = gate();
  const one = queue.run(async () => { order.push("one:start"); await first.opened; order.push("one:end"); return { timing: "files-registry;dur=1.0" }; });
  const two = queue.run(async () => { order.push("two:start"); return { timing: "" }; });
  await Bun.sleep(0);
  expect(queue.diagnostics()).toMatchObject({ waiting: 1, maxWaiting: 2, started: 1 });
  clock = 250;
  first.release();
  const [built, next] = await Promise.all([one, two]);
  expect(order).toEqual(["one:start", "one:end", "two:start"]);
  expect(built.timing).toBe("files-worker-queue;dur=0.0, files-worker-build;dur=250.0, files-registry;dur=1.0");
  expect(next.timing).toBe("files-worker-queue;dur=250.0, files-worker-build;dur=0.0");
  expect(queue.diagnostics().recent).toEqual([{ waitMs: 0, buildMs: 250 }, { waitMs: 250, buildMs: 0 }]);
});

test("a build arriving while the queue is full is refused without running", async () => {
  const queue = createFilesProjectionQueue({ maxDepth: 2, maxWaitMs: 60_000 });
  const held = gate();
  const running = queue.run(async () => { await held.opened; return { timing: "" }; });
  await Bun.sleep(0);
  const waiting = [queue.run(async () => ({ timing: "" })), queue.run(async () => ({ timing: "" }))];
  let ran = false;
  const refused = queue.run(async () => { ran = true; return { timing: "" }; });
  await expect(refused).rejects.toBeInstanceOf(FilesProjectionQueueError);
  await expect(refused).rejects.toMatchObject({ reason: "full" });
  held.release();
  await Promise.all([running, ...waiting]);
  expect(ran).toBe(false);
  expect(queue.diagnostics()).toMatchObject({ refused: 1, started: 3, waiting: 0, maxWaiting: 2 });
});

test("a build that waited past the bound is discarded when its turn comes, and the next one still runs", async () => {
  let clock = 0;
  const queue = createFilesProjectionQueue({ maxDepth: 4, maxWaitMs: 100, now: () => clock });
  const held = gate();
  const running = queue.run(async () => { await held.opened; return { timing: "" }; });
  let stale = false;
  const expired = queue.run(async () => { stale = true; return { timing: "" }; });
  await Bun.sleep(0);
  clock = 500;
  held.release();
  await running;
  await expect(expired).rejects.toMatchObject({ reason: "expired", waitedMs: 500 });
  expect(stale).toBe(false);
  const fresh = await queue.run(async () => ({ timing: "" }));
  expect(fresh.timing).toContain("files-worker-queue;dur=0.0");
  expect(queue.diagnostics()).toMatchObject({ expired: 1, started: 2, maxWaitMs: 500 });
});

test("a failed build releases the queue for the builds behind it", async () => {
  const queue = createFilesProjectionQueue({ maxDepth: 4, maxWaitMs: 1_000 });
  const failed = queue.run(async () => { throw new Error("worker unavailable"); });
  const next = queue.run(async () => ({ timing: "" }));
  await expect(failed).rejects.toThrow("worker unavailable");
  await expect(next).resolves.toMatchObject({ timing: expect.stringContaining("files-worker-build") });
  expect(queue.diagnostics().waiting).toBe(0);
});
