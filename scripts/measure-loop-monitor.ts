/** Run unchanged in base and candidate exports under the same admitted gate.
 * Reports cost, never asserts a machine-dependent timing threshold. */
import { createViewerLoopMonitor } from "../src/lib/viewerLoopMonitor";
import { createPerformanceSpans } from "../src/lib/performanceSpans";
import { createLoopHeapSignals } from "../src/lib/loopHeapSignals";
import { globalCache } from "../src/lib/scanner/caches";

const rows = globalCache<{ text: string; index: number }>("monitor-benchmark");
for (let index = 0; index < 5000; index++) rows.set(String(index), { text: "x".repeat(1024), index });
const buffers = globalCache<Uint8Array>("monitor-benchmark-buffers");
for (let index = 0; index < 64; index++) buffers.set(String(index), new Uint8Array(4096));
const owners = Array.from({ length: 64 }, (_, index) => globalCache<string>(`monitor-benchmark-owner-${index}`));
for (const cache of owners) cache.set("value", "x".repeat(1024));
const ticks = 200_000;
for (const workload of ["healthy", "gaps"] as const) {
  const runs: number[] = [];
  const retainedSamples: number[] = [];
  for (let round = 0; round < 8; round++) {
    let at = 0, lines = 0;
    const spans = createPerformanceSpans(() => at);
    const monitor = createViewerLoopMonitor(() => { lines++; }, () => at, spans,
      createLoopHeapSignals(undefined, () => ({ unavailable: "benchmark" }), () => at));
    let finish!: () => void;
    const pending = monitor.run("history.read", () => new Promise<void>(resolve => { finish = resolve; }));
    const began = performance.now();
    for (let index = 0; index < ticks; index++) {
      at += 10;
      if (workload === "gaps" && index % 500 === 499) monitor.run("files.get", () => { at += 750; });
      monitor.tick();
    }
    const elapsed = performance.now() - began;
    const readSamples = (monitor as unknown as { memorySamples?: () => { samples: unknown[] } }).memorySamples;
    const retained = readSamples?.().samples.length ?? 0;
    if (readSamples && (retained < 100 || retained > 120)) throw new Error("benchmark did not exercise bounded memory retention");
    finish(); await pending; monitor.stop();
    if (round > 0) { runs.push(elapsed * 1000 / ticks); retainedSamples.push(retained); }
    if (lines < 1) throw new Error("benchmark did not exercise summaries");
  }
  const sorted = [...runs].sort((a, b) => a - b);
  console.log(JSON.stringify({ workload, ticks, rounds: runs.length, warmupRounds: 1,
    entries: rows.size + buffers.size + owners.length, cacheOwners: owners.length + 2, textCharsPerEntry: 1024, bufferBytesPerEntry: 4096,
    usPerTick: runs, medianUsPerTick: sorted[Math.floor(sorted.length / 2)], retainedSamples, bun: process.versions.bun }));
}
rows.clear(); buffers.clear();
for (const cache of owners) cache.clear();
