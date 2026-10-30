/** Run unchanged in base and candidate exports under the same admitted gate.
 * Reports cost, never asserts a machine-dependent timing threshold. */
import { createViewerLoopMonitor } from "../src/lib/viewerLoopMonitor";
import { createPerformanceSpans } from "../src/lib/performanceSpans";
import { createLoopHeapSignals } from "../src/lib/loopHeapSignals";
import { globalCache } from "../src/lib/scanner/caches";

if (process.argv.includes("--needle-mutations")) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const { fileHasNeedle } = await import("../src/lib/scanner/needle");
  const root = process.env.LLV_STATE_DIR;
  if (!root || process.env.LLV_VIEWER_CONTROL_URL !== "http://127.0.0.1:1") throw new Error("mutation measurement requires isolated state");
  const directory = path.join(root, "needle-mutation-fixtures");
  fs.mkdirSync(directory, { recursive: true });
  const paths = Array.from({ length: 32 }, (_, index) => path.join(directory, `candidate-${index}.jsonl`));
  for (const pathname of paths) fs.writeFileSync(pathname, "missing\n");
  const cache = globalCache("needle-v2");
  const resources = () => {
    const limits = [];
    if (process.platform === "linux") {
      let directory = "/sys/fs/cgroup" + fs.readFileSync("/proc/self/cgroup", "utf8").split("0::")[1]!.trim();
      while (directory.startsWith("/sys/fs/cgroup")) {
        const read = (file: string) => { try { return fs.readFileSync(path.join(directory, file), "utf8").trim(); } catch { return null; } };
        limits.push({ level: limits.length, cpuMax: read("cpu.max"), memoryMax: read("memory.max"),
          throttledUs: Number(/throttled_usec (\d+)/.exec(read("cpu.stat") ?? "")?.[1] ?? 0) });
        if (directory === "/sys/fs/cgroup") break;
        directory = path.dirname(directory);
      }
    }
    return { loadAverage: os.loadavg(), limits };
  };
  try {
    for (const retained of [0, 64, 1024]) {
      const before = resources();
      const rounds = [];
      for (let round = 0; round < 8; round++) {
        cache.clear();
        const entry = { hits: {}, scanned: {}, sizes: {}, observations: {}, boundaries: {} } as Record<string, Record<string, unknown>>;
        for (let index = 0; index < retained; index++) {
          const key = `retained-${index}`;
          entry.scanned![key] = entry.sizes![key] = 8;
          entry.observations![key] = { dev: 1, ino: index, size: 8, mtimeMs: 1 };
          entry.boundaries![key] = { offset: 0, bytes: 8, fingerprint: "retained-boundary" };
        }
        cache.set("needle", entry);
        let unrelatedDescriptors = 0;
        for (const field of Object.keys(entry)) {
          entry[field] = new Proxy(entry[field]!, {
            getOwnPropertyDescriptor(target, key) {
              if (typeof key === "string" && key.startsWith("retained-")) unrelatedDescriptors++;
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          });
        }
        const cpu = process.cpuUsage(), start = performance.now();
        for (const pathname of paths) {
          if (fileHasNeedle("needle", pathname, { remaining: 1024 })) throw new Error("unexpected fixture hit");
        }
        const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
        if (round > 0) rounds.push({ wallMs, cpuMs: (used.user + used.system) / 1000, unrelatedDescriptors });
      }
      console.log(JSON.stringify({ workload: "needle-mutations", retained, updates: paths.length, warmupRounds: 1,
        fileBytes: 8, allowance: 1024, rounds, resources: { before, after: resources() }, bun: process.versions.bun }));
    }
  } finally { cache.clear(); }
} else {
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
}
