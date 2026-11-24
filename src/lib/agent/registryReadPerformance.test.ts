import { expect, spyOn, test } from "bun:test";
import { createPerformanceSpans, performanceSites, performanceSpans } from "../performanceSpans";
import { requestWorkload } from "../requestWorkload";
import { viewerLoopMonitor, withViewerOperation } from "../viewerLoopMonitor";
import { measureRegistryRead } from "./registryReadPerformance";

test("a keyed read retains its live caller before entering registry.read", async () => {
  let at = 0;
  const recorder = createPerformanceSpans(() => at);
  const sync = spyOn(performanceSpans, "sync").mockImplementation(recorder.sync);
  try {
    let detached!: Promise<void>;
    withViewerOperation("agents.reconcile", () => {
      measureRegistryRead("registry.keyed", () => {
        expect(viewerLoopMonitor.current()).toBe("registry.read");
      }, true);
      requestWorkload.withTool("get_task", () => {
        measureRegistryRead("registry.keyed", () => {}, true);
        detached = Promise.resolve().then(() => {
          expect(viewerLoopMonitor.current()).toBe("agents.reconcile");
          measureRegistryRead("registry.keyed", () => { at += 4; }, true);
        });
      });
    });
    await detached;
    const rows = recorder.snapshot().records.filter(row => performanceSites[row.site] === "registry.keyed");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.registryOperation).toBe("agents.reconcile");
    expect(rows[1]!.requestClass).toBe("mcp:get_task");
    expect(rows[1]!.registryOperation).toBeUndefined();
    expect(rows[2]!.requestClass).toBeUndefined();
    expect(rows[2]!.registryOperation).toBeUndefined();
    expect(rows[2]!.registryCallSite).toContain("src/lib/agent/registryReadPerformance.test.ts:");
    expect(rows[2]!.registryCallSite).not.toContain(import.meta.dir);
  } finally {
    sync.mockRestore();
  }
});
