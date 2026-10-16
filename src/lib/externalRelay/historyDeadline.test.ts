import { expect, test } from "bun:test";
import { withHistoryDeadline, type HistoryClock } from "./historyDeadline";
import http from "node:http";
import { Worker } from "node:worker_threads";

// Advancing wall time does not run callbacks: this models a descheduled loop.
function scheduler() {
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const polls = new Set<() => void>();
  const clock: HistoryClock = {
    now: () => now,
    later(run, ms) { const timer = { at: now + ms, run }; timers.add(timer); return () => { timers.delete(timer); }; },
    afterPoll(run) { polls.add(run); return () => { polls.delete(run); }; },
  };
  return { clock, timers, polls, advance(ms: number) { now += ms; },
    timersTurn() { for (const timer of [...timers].sort((a, b) => a.at - b.at)) if (timer.at <= now && timers.delete(timer)) timer.run(); },
    pollTurn() { for (const run of [...polls]) if (polls.delete(run)) run(); },
  };
}

test("a normal deadline aborts once and cleans its timers", async () => {
  const time = scheduler(), metrics = { elapsedMs: 0, loopGapMs: 0 };
  let signal: AbortSignal | undefined;
  const result = withHistoryDeadline(s => { signal = s; return new Promise(() => {}); }, metrics, time.clock);
  for (let i = 0; i < 40; i++) { time.advance(100); time.timersTurn(); }
  await expect(result).rejects.toMatchObject({ code: "deadline_exceeded" });
  expect(signal!.aborted).toBe(true);
  expect(metrics).toEqual({ elapsedMs: 4000, loopGapMs: 0 });
  expect(time.timers.size + time.polls.size).toBe(0);
});

test("a stalled deadline accepts a response processed in the next poll turn", async () => {
  const time = scheduler(), metrics = { elapsedMs: 0, loopGapMs: 0 };
  let ready!: (value: string) => void;
  let signal: AbortSignal | undefined;
  const result = withHistoryDeadline(s => { signal = s; return new Promise<string>(resolve => { ready = resolve; }); }, metrics, time.clock);
  time.advance(6800); time.timersTurn();
  expect(signal!.aborted).toBe(false);
  expect(time.polls.size).toBe(1);
  ready("readable response");
  expect(await result).toBe("readable response");
  time.pollTurn();
  expect(signal!.aborted).toBe(false);
  expect(metrics).toEqual({ elapsedMs: 6800, loopGapMs: 6700 });
  expect(time.timers.size + time.polls.size).toBe(0);
});

test("a stalled loop with no confirmed response names the stall", async () => {
  const time = scheduler(), metrics = { elapsedMs: 0, loopGapMs: 0 };
  const result = withHistoryDeadline(() => new Promise(() => {}), metrics, time.clock);
  time.advance(6100); time.timersTurn(); time.pollTurn();
  await expect(result).rejects.toMatchObject({ code: "deadline_loop_stalled" });
  expect(metrics).toEqual({ elapsedMs: 6100, loopGapMs: 6000 });
  expect(time.timers.size + time.polls.size).toBe(0);
});

test("success and transport rejection clean timers and preserve the original failure", async () => {
  for (const fails of [false, true]) {
    const time = scheduler(), metrics = { elapsedMs: 0, loopGapMs: 0 };
    const failure = new Error("synthetic failure");
    const result = withHistoryDeadline(async () => { time.advance(25); if (fails) throw failure; return "ok"; }, metrics, time.clock);
    if (fails) await expect(result).rejects.toBe(failure);
    else expect(await result).toBe("ok");
    expect(metrics).toEqual({ elapsedMs: 25, loopGapMs: 0 });
    expect(time.timers.size + time.polls.size).toBe(0);
  }
});

test("real readable HTTP survives a loop stall or reports the stalled deadline", async () => {
  const barrier = new Int32Array(new SharedArrayBuffer(4));
  // An independently scheduled server can send while the client loop is held.
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const barrier = new Int32Array(workerData);
    const server = require('node:http').createServer((req, res) => {
      res.on('error', () => {});
      res.end('{}', () => { Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0); });
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
  `, { eval: true, workerData: barrier.buffer });
  let request: http.ClientRequest | undefined;
  let barrierResult: string | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    const metrics = { elapsedMs: 0, loopGapMs: 0 };
    const outcome = withHistoryDeadline(signal => new Promise<string>((resolve, reject) => {
      request = http.get({ hostname: "127.0.0.1", port, signal, agent: false }, response => {
        response.on("error", reject);
        let text = "";
        response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve(text));
      });
      request.on("error", reject);
      request.once("finish", () => {
        // Deliberate test-only barrier after the request has left the client.
        barrierResult = Atomics.wait(barrier, 0, 0, 5000);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      });
    }), metrics, undefined, 1000).then(body => ({ body, code: null }), error => ({ body: null, code: error.code }));
    const result = await outcome;
    expect(barrierResult).toBeDefined();
    expect(barrierResult).not.toBe("timed-out");
    expect(result.body === "{}" || result.code === "deadline_loop_stalled").toBe(true);
    expect(metrics.loopGapMs).toBeGreaterThan(100);
  } finally { request?.destroy(); await worker.terminate(); }
}, 12000);


test("a stall ending exactly at the deadline is still identified", async () => {
  const time = scheduler(), metrics = { elapsedMs: 0, loopGapMs: 0 };
  const result = withHistoryDeadline(() => new Promise(() => {}), metrics, time.clock);
  time.advance(4000); time.timersTurn();
  expect(time.polls.size).toBe(1);
  time.pollTurn();
  await expect(result).rejects.toMatchObject({ code: "deadline_loop_stalled" });
  expect(metrics).toEqual({ elapsedMs: 4000, loopGapMs: 3900 });
  expect(time.timers.size + time.polls.size).toBe(0);
});

test("an earlier recovered stall does not relabel an on-time deadline", async () => {
  const time = scheduler(), metrics = { elapsedMs: 0, loopGapMs: 0 };
  const result = withHistoryDeadline(() => new Promise(() => {}), metrics, time.clock);
  time.advance(1000); time.timersTurn();
  for (let i = 0; i < 30; i++) { time.advance(100); time.timersTurn(); }
  await expect(result).rejects.toMatchObject({ code: "deadline_exceeded" });
  expect(metrics).toEqual({ elapsedMs: 4000, loopGapMs: 900 });
  expect(time.timers.size + time.polls.size).toBe(0);
});
