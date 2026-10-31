import { expect, test } from "bun:test";
import { startTempSweep, stopTempSweep } from "@/lib/tempSweep";
import { startWorktreeSweep, stopWorktreeSweep } from "@/lib/pipelines/worktreeSweep";
import { requestDiskPressureSweeps } from "./diskPressureSweeps";

test("pressure advances idle sweep timers and never overlaps their in-flight work", async () => {
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const calls: string[] = [];
  const run = (kind: string) => async () => {
    calls.push(kind); if (calls.length === 2) ready();
    await held;
  };
  const old = process.env.LLV_TEMP_SWEEP;
  process.env.LLV_TEMP_SWEEP = "on";
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    startTempSweep({ firstDelayMs: 60_000, sweep: run("temp") });
    startWorktreeSweep({ firstDelayMs: 60_000, env: { LLV_WORKTREE_SWEEP: "on" }, sweep: run("worktrees") });
    requestDiskPressureSweeps();
    await Promise.race([started, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("early sweep did not start")), 5000); })]);
    requestDiskPressureSweeps();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls.sort()).toEqual(["temp", "worktrees"]);
  } finally {
    if (deadline) clearTimeout(deadline);
    stopTempSweep(); stopWorktreeSweep(); release();
    if (old === undefined) delete process.env.LLV_TEMP_SWEEP; else process.env.LLV_TEMP_SWEEP = old;
  }
});
