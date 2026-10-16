import { expect, test } from "bun:test";
import { withHistoryDeadline, type HistoryClock } from "./historyDeadline";

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

test("a recovered stall 100 ms before the deadline is not attributed to its timer", async () => {
  const time = scheduler(), metrics = { elapsedMs: 0, loopGapMs: 0 };
  const result = withHistoryDeadline(() => new Promise(() => {}), metrics, time.clock);
  for (let i = 0; i < 36; i++) { time.advance(100); time.timersTurn(); }
  time.advance(300); time.timersTurn(); // 200 ms heartbeat lateness; loop resumes at 3900 ms.
  time.advance(100); time.timersTurn(); time.pollTurn(); // The deadline fires on time at 4000 ms.
  await expect(result).rejects.toMatchObject({ code: "deadline_exceeded" });
  expect(metrics).toEqual({ elapsedMs: 4000, loopGapMs: 200 });
  expect(time.timers.size + time.polls.size).toBe(0);
});
