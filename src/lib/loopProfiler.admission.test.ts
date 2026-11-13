import { expect, test } from "bun:test";
import { createLoopProfiler, type LoopGapProfile } from "./loopProfiler";

test.each(["arm-expired", "kill-switch", "stopped", "waiting-for-capture"] as const)(
  "buffered gaps survive %s during admission exactly once", async reason => {
    let at = 0, on = true, collections = 0;
    const emitted: LoopGapProfile[][] = [[], []];
    let release!: () => void;
    let entered!: () => void;
    const admission = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const recorder = createLoopProfiler({
      now: () => at, root: process.cwd(), enabled: async () => on,
      collect: async () => { collections++; return { stackTraces: { traces: [] } }; },
      sleep: async () => {}, phase: (_phase, work) => work(), flushTick: () => {},
      beforeCollect: async () => { entered(); await held; return reason !== "waiting-for-capture"; },
    }, 5000);
    const run = recorder.start();
    await admission;
    at = 3010;
    for (const [index, gapMs] of [600, 3000].entries()) {
      expect(recorder.correlate(0, at, gapMs, profile => emitted[index]!.push(profile))).toBe(true);
    }
    if (reason === "arm-expired") at = 6010;
    if (reason === "kill-switch") on = false;
    if (reason === "stopped") recorder.stop();
    release(); await run;
    expect(collections).toBe(0);
    for (const records of emitted) expect(records).toEqual([{ status: "not-armed", reason }]);
    await recorder.start(); recorder.stop();
    for (const records of emitted) expect(records).toHaveLength(1);
  });
