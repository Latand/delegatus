import { expect, test } from "bun:test";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import { createPerformanceSpans } from "./performanceSpans";
import { createLoopHeapSignals } from "./loopHeapSignals";

test("every loop-gap carries memory signals; ordinary ticks advance the heap baseline", () => {
  let at = 0, heap = 1000;
  const lines: string[] = [];
  const signals = createLoopHeapSignals(() => heap, () => ({ unavailable: "gc-entry-unsupported" }), () => at);
  signals.start();
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, createPerformanceSpans(() => at), signals);
  at = 250; heap = 2000; monitor.tick();
  expect(lines).toEqual([]);
  at = 1260; heap = 5000; monitor.tick(); // gap = exactly 1000
  at = 2271; heap = 1000; monitor.tick(); // gap = 1001
  expect(lines).toHaveLength(2);
  const reports = lines.map(line => JSON.parse(line.slice("[viewer loop-gap] ".length)));
  expect(reports[0].heap.deltaBytes).toBe(3000);
  expect(reports[0].heap.beforeBytes).toBeUndefined();
  expect(reports[1].heap).toMatchObject({ deltaBytes: -4000, beforeBytes: 5000, afterBytes: 1000 });
  for (const report of reports) {
    expect(report.gc).toEqual({ source: "unavailable", count: null, ms: null, reason: "gc-entry-unsupported" });
    expect(report.heap.allocatedBytes).toBeNull();
    expect(report.heap.freedBytes).toBeNull();
    expect(report.attribution.unresolved).toBe("unknown-runtime-or-native");
  }
  monitor.stop();
});
