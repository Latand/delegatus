import { expect, test } from "bun:test";
import { SeatTickTimings, SEAT_TICK_TIMING_LIMIT, compactSeatTickTiming, sanitizeSeatTickTiming } from "./seatTickTiming";
import { SeatTickWork, seatTickQueueSpan } from "./seatTickWork";

test("timings keep exact boundaries and CPU deltas and bound unfinished spans", () => {
  let now = 0, cpu = 0;
  const trace = new SeatTickTimings(() => now, () => ({ user: cpu, system: 0 }));
  const end = trace.begin("check.registry");
  now = 12; cpu = 45; end(); end();
  trace.begin("files.seat-reports.queue");
  now = 30; cpu = 50;
  const snapshot = trace.snapshot();
  expect(snapshot.phases).toEqual([
    { phase: "check.registry", beginMs: 0, endMs: 12, cpuUs: 45 },
    { phase: "files.seat-reports.queue", beginMs: 12, endMs: 30, cpuUs: 5, pending: true },
  ]);
  expect(snapshot).toMatchObject({ elapsedMs: 30, cpuUs: 50, dropped: 0 });
  expect(sanitizeSeatTickTiming(snapshot)).toEqual(snapshot);
  expect(sanitizeSeatTickTiming(compactSeatTickTiming(snapshot))).toEqual(snapshot);
  for (let i = 0; i < SEAT_TICK_TIMING_LIMIT; i++) trace.begin("check.seat");
  expect(trace.snapshot().phases).toHaveLength(SEAT_TICK_TIMING_LIMIT);
  expect(trace.snapshot().dropped).toBe(2);
});

test("sync work, async failures and optional source queue work share one check trace", async () => {
  let now = 0;
  const work = new SeatTickWork("fixture", 1000, () => now);
  try {
    await work.run(async () => {
      const ports = work.ports({
        registry: () => { now += 2; return 1; },
        failed: async () => { now += 3; throw Error("fixture read failed"); },
      }, "check.sources");
      expect(ports.registry()).toBe(1);
      await expect(ports.failed()).rejects.toThrow("fixture read failed");
      await work.source("liveness", async () => {
        const end = seatTickQueueSpan("files.seat-liveness.queue"); now += 7; end(); return [];
      }, []);
    });
    expect(work.timings.snapshot().phases).toEqual(expect.arrayContaining([
      { phase: "check.sources.registry", beginMs: 0, endMs: 2, cpuUs: expect.any(Number) },
      { phase: "check.sources.failed", beginMs: 2, endMs: 5, cpuUs: expect.any(Number) },
      { phase: "files.seat-liveness.queue", beginMs: 5, endMs: 12, cpuUs: expect.any(Number) },
    ]));
  } finally { work.close(); }
});

test("a failing phase after the timing cap remains diagnosable", async () => {
  let now = 0, cpu = 0;
  const work = new SeatTickWork("fixture", 10_000, () => now);
  const ports = work.ports({ read: () => { now++; cpu += 3; return cpu; }, fail: () => { now += 4; cpu += 11; throw Error("late source failure"); } }, "check.sources");
  try {
    for (let i = 0; i < SEAT_TICK_TIMING_LIMIT; i++) ports.read();
    expect(() => ports.fail()).toThrow("late source failure");
    const timing = work.timings.snapshot();
    expect(timing.phases).toHaveLength(SEAT_TICK_TIMING_LIMIT);
    expect(timing.dropped).toBe(1);
    expect(timing.phases[0]!.beginMs).toBe(1);
    expect(timing.phases.at(-1)).toMatchObject({ phase: "check.sources.fail", beginMs: 512, endMs: 516 });
    expect(timing.phases.at(-1)!.cpuUs).toBeGreaterThanOrEqual(0);
    expect(sanitizeSeatTickTiming(compactSeatTickTiming(timing))?.phases.at(-1)).toEqual(timing.phases.at(-1));
  } finally { work.close(); }
});

test("timing reader rejects invalid headers and bounds malformed or excessive phases", () => {
  const trace = new SeatTickTimings(); trace.begin("check.registry")();
  const snapshot = trace.snapshot();
  for (const patch of [{ checkId: "/private/path" }, { elapsedMs: Infinity }, { cpuUs: -1 }, { startedAt: "invalid" }, { phases: null }]) {
    expect(sanitizeSeatTickTiming({ ...snapshot, ...patch })).toBeUndefined();
  }
  const bad = [null, { phase: "payload with spaces", beginMs: 0, endMs: 1, cpuUs: 1 },
    { phase: "check.registry", beginMs: 2, endMs: 1, cpuUs: 0 }];
  expect(sanitizeSeatTickTiming({ ...snapshot, phases: bad })?.phases).toEqual([]);
  const many = Array.from({ length: SEAT_TICK_TIMING_LIMIT + 3 }, () => snapshot.phases[0]);
  expect(sanitizeSeatTickTiming({ ...snapshot, phases: many })).toMatchObject({ dropped: 3, phases: many.slice(0, SEAT_TICK_TIMING_LIMIT) });
});
