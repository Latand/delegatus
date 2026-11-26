import path from "node:path";
import { expect, test } from "bun:test";

import { forEachCooperatively, observeCooperativeQueue, yieldToRuntime } from "./cooperative";

/*
 * Every cooperative yield of the process goes through one queue
 * (docs/design/viewer-stalls-root-cause.md, section 3.3). While each yield
 * armed its own immediate, the jobs that had yielded all resumed inside one
 * loop turn: 45 jobs with 12 ms slices stalled the loop for a second at a
 * time. These hold the order of the queue, what one turn may resume, and the
 * measurement the stall was found with.
 */

/** A synchronous slice of work that takes at least `ms`. */
function burn(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* busy */ }
}

/** Resolves after the queue has been empty for a full turn, so one test's jobs never share a turn with the next's. */
async function settled(): Promise<void> {
  await yieldToRuntime();
  await new Promise(resolve => setTimeout(resolve, 0));
}

test("jobs resume in the order they yielded, and each job's steps stay in its own order", async () => {
  await settled();
  const log: string[] = [];
  const job = async (name: string) => {
    for (let step = 1; step <= 3; step += 1) {
      log.push(`${name}${step}`);
      await yieldToRuntime();
    }
  };
  await Promise.all([job("a"), job("b"), job("c")]);
  expect(log).toEqual(["a1", "b1", "c1", "a2", "b2", "c2", "a3", "b3", "c3"]);
});

test("a job is never resumed in the turn it yielded in", async () => {
  await settled();
  const before = observeCooperativeQueue();
  for (let step = 0; step < 25; step += 1) await yieldToRuntime();
  const after = observeCooperativeQueue();
  expect(after.resumed - before.resumed).toBe(25);
  expect(after.turns - before.turns).toBeGreaterThanOrEqual(25);
});

test("a slice longer than the turn's budget has the turn to itself", async () => {
  await settled();
  const before = observeCooperativeQueue();
  const job = async () => {
    for (let step = 0; step < 4; step += 1) {
      await yieldToRuntime();
      burn(8);
    }
  };
  await Promise.all(Array.from({ length: 6 }, job));
  const after = observeCooperativeQueue();
  expect(after.resumed - before.resumed).toBe(24);
  /* One job per turn: as many turns as resumed slices. */
  expect(after.turns - before.turns).toBeGreaterThanOrEqual(24);
});

test("slices that fit the turn's budget share a turn", async () => {
  await settled();
  const before = observeCooperativeQueue();
  let steps = 0;
  const job = async () => {
    for (let step = 0; step < 10; step += 1) {
      await yieldToRuntime();
      steps += 1;
    }
  };
  await Promise.all(Array.from({ length: 40 }, job));
  const after = observeCooperativeQueue();
  expect(steps).toBe(400);
  expect(after.resumed - before.resumed).toBe(400);
  /* 40 jobs that do next to nothing per slice take about a turn per round, never a turn per slice. */
  expect(after.turns - before.turns).toBeLessThan(200);
});

test("a timer fires between the turns of jobs with long slices", async () => {
  await settled();
  let ticks = 0;
  let longestGapMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const at = performance.now();
    ticks += 1;
    longestGapMs = Math.max(longestGapMs, at - last);
    last = at;
  }, 5);
  try {
    const job = async () => {
      for (let step = 0; step < 6; step += 1) {
        await yieldToRuntime();
        burn(6);
      }
    };
    /* All ten jobs yield first, so no slice runs before the queue orders them. */
    last = performance.now();
    await Promise.all(Array.from({ length: 10 }, job));
  } finally { clearInterval(timer); }
  /* Sixty slices of 6 ms: back to back in one turn they are a 360 ms gap with no tick inside. */
  expect(ticks).toBeGreaterThanOrEqual(30);
  expect(longestGapMs).toBeLessThan(120);
});

test("a withdrawn wait rejects with the signal's reason and the queue passes over it", async () => {
  await settled();
  const log: string[] = [];
  const controller = new AbortController();
  const first = yieldToRuntime().then(() => { log.push("first"); });
  const withdrawn = yieldToRuntime(controller.signal).then(() => { log.push("withdrawn"); }, (error: unknown) => { log.push(`rejected:${String(error)}`); });
  const last = yieldToRuntime().then(() => { log.push("last"); });
  controller.abort("the job was cancelled");
  await Promise.all([first, withdrawn, last]);
  expect(log).toEqual(["rejected:the job was cancelled", "first", "last"]);
  expect(observeCooperativeQueue().depth).toBe(0);

  /* A signal that is already aborted never enters the queue. */
  const before = observeCooperativeQueue();
  await expect(yieldToRuntime(AbortSignal.abort("already cancelled"))).rejects.toBe("already cancelled");
  expect(observeCooperativeQueue().resumed).toBe(before.resumed);

  /* A wait that was resumed no longer listens to its signal. */
  const later = new AbortController();
  await yieldToRuntime(later.signal);
  later.abort("too late to matter");
  await yieldToRuntime();
});

test("an observation reports what waited since the previous one and counters that only grow", async () => {
  await settled();
  observeCooperativeQueue();
  const waits = Array.from({ length: 7 }, () => yieldToRuntime());
  const during = observeCooperativeQueue();
  expect(during.depth).toBe(7);
  expect(during.maxDepth).toBe(7);
  await Promise.all(waits);
  const after = observeCooperativeQueue();
  expect(after.depth).toBe(0);
  expect(after.resumed - during.resumed).toBe(7);
  expect(after.turns).toBeGreaterThan(during.turns);
  /* The window starts again at each observation. */
  expect(observeCooperativeQueue().maxDepth).toBe(0);
  expect(observeCooperativeQueue().longestWaitMs).toBe(0);
});

test("a queue that never empties keeps its order and drops the slots it has resumed", async () => {
  await settled();
  const before = observeCooperativeQueue();
  const log: number[] = [];
  let running = true;
  /* Three jobs keep the queue occupied for thousands of slices, as a saturated process does. */
  const job = async (name: number) => {
    while (running) {
      log.push(name);
      await yieldToRuntime();
    }
  };
  const jobs = [job(0), job(1), job(2)];
  while (observeCooperativeQueue().resumed - before.resumed < 6_000) await new Promise(resolve => setTimeout(resolve, 1));
  running = false;
  await Promise.all(jobs);
  expect(observeCooperativeQueue().depth).toBe(0);
  /* Round robin throughout: the order survives every compaction of the queue. */
  expect(log.length).toBeGreaterThan(6_000);
  for (let index = 0; index < log.length; index += 1) {
    if (log[index] !== index % 3) throw new Error(`slice ${index} went to job ${log[index]}`);
  }
});

test("cooperative iteration still visits every value in order", async () => {
  const seen: number[] = [];
  await forEachCooperatively(Array.from({ length: 100 }, (_, index) => index), (value) => { seen.push(value); }, { batchSize: 7 });
  expect(seen).toEqual(Array.from({ length: 100 }, (_, index) => index));
});

/*
 * The measurement of section 3.3, on the runtime this test runs under, in a
 * process of its own: 45 jobs with 12 ms slices for 4.5 s. Before the queue
 * the timer ticked 8 times and every gap was above a second.
 */
test("45 jobs with 12 ms slices leave the loop its turns", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "cooperative.loopGap.fixture.ts"), "45", "12", "4500"],
    { stdout: "pipe", stderr: "inherit" });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  const measured = JSON.parse(output.trim()) as { slices: number; ticks: number; longestGapMs: number; p95GapMs: number; stalledMs: number };
  /* Measured on an idle run: 331 or more ticks and a longest gap under 50 ms.
     On a machine that is also running other suites the process loses time to
     the scheduler, so the bounds here are the ones no such loss reaches and
     the old behaviour (8 ticks, gaps above 1 000 ms) cannot meet. */
  expect(measured.ticks).toBeGreaterThanOrEqual(200);
  expect(measured.p95GapMs).toBeLessThan(50);
  expect(measured.longestGapMs).toBeLessThan(500);
  expect(measured.stalledMs).toBe(0);
  expect(measured.slices).toBeGreaterThan(200);
}, 60_000);
