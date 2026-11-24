import fs from "node:fs";
import { expect, spyOn, test } from "bun:test";
import { createPerformanceSpans, performanceSites, performanceSpans } from "../performanceSpans";
import { requestWorkload } from "../requestWorkload";
import { viewerLoopMonitor, withViewerOperation } from "../viewerLoopMonitor";
import { measureRegistryRead } from "./registryReadPerformance";

function counter(owner: string): number {
  const minute = Math.floor(process.uptime() / 60);
  return requestWorkload.snapshot(minute - 1, minute).minutes.reduce((sum, row) =>
    sum + (row.registryReads["registry.keyed|" + owner] ?? 0), 0);
}

test("keyed reads pass a primitive pause label and preserve the workload owner after detachment", async () => {
  let at = 0, executions = 0;
  const recorder = createPerformanceSpans(() => at);
  const argumentsSeen: unknown[] = [];
  const sync = spyOn(performanceSpans, "sync").mockImplementation((site, work, rows, bytes, operation) => {
    argumentsSeen.push(operation);
    return recorder.sync(site, work, rows, bytes, operation);
  });
  const before = ["agents.reconcile", "mcp:get_task", "unscoped"].map(counter);
  const realpath = spyOn(fs, "realpathSync");
  const value = {};
  const error = new Error("fixture read error");
  const read = () => measureRegistryRead("registry.keyed", () => {
    executions++;
    at += 4;
    return value;
  }, true);
  try {
    let detached!: Promise<void>;
    withViewerOperation("agents.reconcile", () => {
      expect(read()).toBe(value);
      requestWorkload.withTool("get_task", () => {
        expect(read()).toBe(value);
        detached = Promise.resolve().then(() => {
          expect(viewerLoopMonitor.current()).toBe("agents.reconcile");
          expect(read()).toBe(value);
        });
      });
    });
    await detached;
    let caught: unknown;
    try {
      measureRegistryRead("registry.keyed", () => { executions++; at += 4; throw error; });
    } catch (thrown) { caught = thrown; }
    expect(caught).toBe(error);
    expect(executions).toBe(4);
    expect(realpath).not.toHaveBeenCalled();
    expect(argumentsSeen).toEqual(["agents.reconcile", "agents.reconcile", undefined, undefined]);
    const after = ["agents.reconcile", "mcp:get_task", "unscoped"].map(counter);
    expect(after.map((n, i) => n - before[i]!)).toEqual([2, 1, 1]);
    const rows = recorder.snapshot().records.filter(row => performanceSites[row.site] === "registry.keyed");
    expect(rows.map(row => row.registryOperation)).toEqual(["agents.reconcile", undefined, undefined, undefined]);
    expect(rows.map(row => row.requestClass)).toEqual([undefined, "mcp:get_task", undefined, undefined]);
    expect(rows[3]!.failed).toBe(true);
  } finally {
    realpath.mockRestore();
    sync.mockRestore();
  }
});
