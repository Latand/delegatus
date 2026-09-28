import { expect, test } from "bun:test";

import { LinkedBoardSchedule, TICK_MS, type SchedulePorts } from "./schedule";

const HOUR = 3_600_000;

function fixture(options: { open?: (now: number) => boolean; moved?: (call: number) => number; fail?: (call: number) => boolean; push?: (now: number) => boolean } = {}) {
  let now = 0;
  let revision = 1;
  const calls: number[] = [];
  const ports: SchedulePorts = {
    now: () => now,
    links: () => [{ id: "peer", projects: new Set(["repo-a"]) }],
    ownRevision: () => revision,
    hasPush: () => options.push?.(now) ?? false,
    boardOpen: () => options.open?.(now) ?? false,
    sync: async () => {
      calls.push(now);
      if (options.fail?.(calls.length)) throw new Error("unreachable");
      return { moved: options.moved?.(calls.length) ?? 0 };
    },
  };
  const schedule = new LinkedBoardSchedule(ports);
  return {
    calls,
    bump: () => { revision++; },
    async run(untilMs: number) { while (now < untilMs) { await schedule.tick(); now += schedule.nextDelay(); } },
  };
}

const inHour = (calls: number[], hour: number) => calls.filter((at) => at >= hour * HOUR && at < (hour + 1) * HOUR).length;

test("an idle link backs off to at most 12 calls an hour over 3 idle hours", async () => {
  const idle = fixture();
  await idle.run(3 * HOUR);
  expect(inHour(idle.calls, 1)).toBeLessThanOrEqual(12);
  expect(inHour(idle.calls, 2)).toBeLessThanOrEqual(12);
  expect(idle.calls.length).toBeLessThanOrEqual(12 * 3 + 5);
});

test("an open board of a linked project allows up to 240 calls an hour, and only while it is open", async () => {
  const open = fixture({ open: (now) => now < HOUR });
  await open.run(3 * HOUR);
  expect(inHour(open.calls, 0)).toBeLessThanOrEqual(240);
  expect(inHour(open.calls, 0)).toBeGreaterThan(200);
  expect(inHour(open.calls, 2)).toBeLessThanOrEqual(12);
});

test("a linked change starts a call at the next tick, and a call that moved data keeps a 10 s pace for 2 minutes", async () => {
  let pending = false;
  const changed = fixture({ push: () => pending, moved: (call) => (call === 2 ? 1 : 0) });
  await changed.run(HOUR);
  const before = changed.calls.length;
  pending = true;
  changed.bump();
  await changed.run(HOUR + 1_000);
  pending = false;
  expect(changed.calls.length).toBe(before + 1);
  expect(changed.calls.at(-1)).toBe(HOUR);
  // Call 2 moved data: the calls after it come every 10 s for 2 minutes.
  const burst = fixture({ moved: (call) => (call === 1 ? 1 : 0) });
  await burst.run(125_000);
  expect(burst.calls.slice(0, 13)).toEqual(Array.from({ length: 13 }, (_, index) => index * TICK_MS));
});

test("failures back off to 5 minutes", async () => {
  const failing = fixture({ fail: () => true });
  await failing.run(2 * HOUR);
  const gaps = failing.calls.slice(1).map((at, index) => at - failing.calls[index]!);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(310_000);
  expect(gaps.slice(-3).every((gap) => gap >= 300_000)).toBe(true);
});
