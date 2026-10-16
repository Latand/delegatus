import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { heapStats } from "bun:jsc";

import { AgentRegistry, normalizeRegistry } from "../src/lib/agent/registry";
import { SqliteAgentRegistryStore } from "../src/lib/agent/sqliteRegistryStore";
import { createViewerLoopMonitor } from "../src/lib/viewerLoopMonitor";

// Run through gate-slot with isolated HOME, XDG_CONFIG_HOME, TMPDIR and
// LLV_STATE_DIR. The input is an offline backup; it is copied before opening.
const [input, output, label, countText = "12"] = process.argv.slice(2);
const root = process.env.LLV_STATE_DIR;
const count = Number(countText);
if (!input || !output || !label || !root || !Number.isSafeInteger(count) || count < 1) {
  throw new Error("usage: registry-write-benchmark.ts <offline-db> <output-json> <label> [iterations]");
}
fs.mkdirSync(root, { recursive: true });
const round = (value: number) => Math.round(value * 1000) / 1000;
const summary = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b);
  const at = (p: number) => round(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * p))] ?? 0);
  return { samples: values.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
};
const inputSha256 = process.env.REGISTRY_WRITE_BENCH_INPUT_SHA256 ?? await (async () => {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(input)) hash.update(chunk);
  return hash.digest("hex");
})();
if (!/^[a-f0-9]{64}$/.test(inputSha256)) throw new Error("invalid offline input digest");
const readBytes = () => Number(fs.readFileSync("/proc/self/io", "utf8").match(/^rchar:\s+(\d+)/m)![1]);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const workloads = ["keyed", "writer-snapshot", "serialized-snapshot", "keyed-with-snapshot", "compaction-control"] as const;
const results: unknown[] = [];
const logicalNow = Date.parse("2026-10-16T08:00:00.000Z");
const sourceFiles = ["src/lib/agent/sqliteRegistryStore.ts", "src/lib/agent/registry.ts", "src/lib/agent/registryArchive.ts",
  "src/lib/performanceSpans.ts", "src/lib/viewerLoopMonitor.ts", "scripts/registry-write-benchmark.ts"];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash("sha256").update(fs.readFileSync(new URL(`../${file}`, import.meta.url))).digest("hex")]));

for (const workload of workloads) {
  Bun.gc(true);
  const directory = fs.mkdtempSync(path.join(root, "registry-write-"));
  const filename = path.join(directory, "agent-registry.sqlite");
  fs.copyFileSync(input, filename);
  const census = new Database(filename, { readonly: true });
  const rows = census.query<{ count: number; bytes: number }, []>(
    "SELECT COUNT(*) AS count,SUM(length(CAST(value_json AS BLOB))) AS bytes FROM registry_rows",
  ).get()!;
  const cold = census.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM registry_cold").get()!.count;
  const key = census.query<{ row_key: string }, []>("SELECT row_key FROM registry_rows WHERE collection='receipts' ORDER BY row_order LIMIT 1").get()!.row_key;
  census.close();
  let payloadReads = 0;
  let parsed = 0;
  let trackHeap = false;
  let peakHeapBytes = 0;
  let activeHeapBaseline: number | null = null;
  let activeHeapPeak = 0;
  const sampleHeap = () => {
    if (!trackHeap) return;
    peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
    if (activeHeapBaseline !== null) activeHeapPeak = Math.max(activeHeapPeak, heapStats().heapSize);
  };
  const storeStarted = performance.now();
  const store = new SqliteAgentRegistryStore(filename, {
    normalize: normalizeRegistry, initialSnapshot: () => { throw new Error("offline input must already be imported"); },
    onRowPayloadRead: (_collection, amount) => { payloadReads += amount; if (amount >= 256) sampleHeap(); },
    onRowPayloadParse: (_collection, amount) => { parsed += amount; if (parsed >= 512) { parsed = 0; sampleHeap(); } },
  });
  const storeOpenMs = round(performance.now() - storeStarted);
  const gaps: number[] = [];
  const loggedGaps: number[] = [];
  const monitor = createViewerLoopMonitor(line => {
    if (line.startsWith("[viewer loop-gap] ")) loggedGaps.push(JSON.parse(line.slice("[viewer loop-gap] ".length)).gapMs);
  });
  let compactionRegistry: AgentRegistry | null = null;
  try {
    trackHeap = true;
    activeHeapBaseline = heapStats().heapSize;
    activeHeapPeak = activeHeapBaseline;
    const warmStarted = performance.now();
    const warmBytes = readBytes();
    store.snapshot();
    sampleHeap();
    const warm = {
      wallMs: round(performance.now() - warmStarted),
      readBytes: readBytes() - warmBytes,
      payloadReads,
      heapUsedAfterBytes: process.memoryUsage().heapUsed,
      allocatedHeapPeakBytes: Math.max(0, activeHeapPeak - activeHeapBaseline),
    };
    activeHeapBaseline = null;
    Bun.gc(true);
    payloadReads = 0;
    parsed = 0;
    sampleHeap();
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      gaps.push(Math.max(0, now - last - 10));
      last = now;
    }, 10);
    const operations: Array<{ kind?: string; wallMs: number; readBytes: number; payloadReads: number;
      heapUsedAfterBytes: number; allocatedHeapPeakBytes: number }> = [];
    let firstCompaction: {
      registryOpenMs: number;
      wallMs: number;
      readBytes: number;
      payloadReads: number;
      allocatedHeapPeakBytes: number;
      heapUsedAfterBytes: number;
    } | null = null;
    monitor.start();
    try {
    if (workload === "compaction-control") {
      const registryStarted = performance.now();
      compactionRegistry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
        sqliteMode: "sqlite", now: () => logicalNow,
        onSqliteRowPayloadRead: (_collection, amount) => { payloadReads += amount; if (amount >= 256) sampleHeap(); },
        onSqliteRowPayloadParse: (_collection, amount) => { parsed += amount; if (parsed >= 512) { parsed = 0; sampleHeap(); } },
      });
      const registryOpenMs = round(performance.now() - registryStarted);
      await sleep(25);
      const beforeReads = payloadReads;
      const beforeBytes = readBytes();
      activeHeapBaseline = heapStats().heapSize;
      activeHeapPeak = activeHeapBaseline;
      const start = performance.now();
      await compactionRegistry.deliveryWrite({ label: "benchmark.compaction.initial" }, () => compactionRegistry!.compactDeliveryReservations());
      sampleHeap();
      firstCompaction = {
        registryOpenMs,
        wallMs: round(performance.now() - start),
        readBytes: readBytes() - beforeBytes,
        payloadReads: payloadReads - beforeReads,
        allocatedHeapPeakBytes: Math.max(0, activeHeapPeak - activeHeapBaseline),
        heapUsedAfterBytes: process.memoryUsage().heapUsed,
      };
      operations.push({
        kind: "initial",
        wallMs: firstCompaction.wallMs,
        readBytes: firstCompaction.readBytes,
        payloadReads: firstCompaction.payloadReads,
        allocatedHeapPeakBytes: firstCompaction.allocatedHeapPeakBytes,
        heapUsedAfterBytes: firstCompaction.heapUsedAfterBytes,
      });
      activeHeapBaseline = null;
      await sleep(15);
    }
      const noChangeTicks = workload === "compaction-control" ? 3 : 0;
      const changedTicks = workload === "compaction-control" ? 3 : 0;
      const iterations = workload === "compaction-control" ? noChangeTicks + changedTicks : count;
      for (let iteration = 0; iteration < iterations; iteration++) {
        await sleep(25);
        if (workload === "compaction-control" && iteration >= noChangeTicks) {
          const delta = iteration - noChangeTicks;
          const conversation = compactionRegistry!.ensureConversation("codex", "/registry-benchmark/compaction-" + delta + ".jsonl", null);
          const delivery = compactionRegistry!.holdDelivery(conversation.id, "compaction payload " + delta,
            "compaction-message-" + delta, "text", [], null, { operationId: "compaction-operation-" + delta });
          compactionRegistry!.recordDeliveryOutcome(delivery.id, "failed", "unverified", "unverified");
        }
        const beforeReads = payloadReads;
        const beforeBytes = readBytes();
        activeHeapBaseline = heapStats().heapSize;
        activeHeapPeak = activeHeapBaseline;
        const start = performance.now();
        if (workload === "writer-snapshot") store.snapshot();
        else if (workload === "serialized-snapshot") {
          const serialized = JSON.stringify(store.snapshot().file);
          if (!serialized.length) throw new Error("snapshot serialization was empty");
        }
        else if (workload === "compaction-control") {
          await compactionRegistry!.deliveryWrite({
            label: "benchmark.compaction." + (iteration < noChangeTicks ? "unchanged" : "one-change"),
          }, () => compactionRegistry!.compactDeliveryReservations());
        } else {
          await store.withWriter(() => store.mutate(file => {
            file.receipts[key]!.error = `benchmark change ${iteration}`;
          }, workload === "keyed-with-snapshot"));
        }
        sampleHeap();
        operations.push({
          ...(workload === "compaction-control" ? { kind: iteration < noChangeTicks ? "unchanged" : "one-change" } : {}),
          wallMs: round(performance.now() - start),
          readBytes: readBytes() - beforeBytes,
          payloadReads: payloadReads - beforeReads,
          heapUsedAfterBytes: process.memoryUsage().heapUsed,
          allocatedHeapPeakBytes: Math.max(0, activeHeapPeak - activeHeapBaseline),
        });
        activeHeapBaseline = null;
        // Let the independent timer observe each synchronous operation.
        await sleep(15);
      }
    } finally {
      monitor.stop();
      clearInterval(timer);
    }
    const groupSummary = (kind: string) => {
      const group = operations.filter(operation => operation.kind === kind);
      return {
        samples: group.length,
        wallMs: summary(group.map(row => row.wallMs)),
        readBytes: summary(group.map(row => row.readBytes)),
        payloadReads: summary(group.map(row => row.payloadReads)),
        allocatedHeapPeakBytes: summary(group.map(row => row.allocatedHeapPeakBytes)),
      };
    };
    results.push({ workload, rows: rows.count, payloadBytes: rows.bytes, coldRows: cold,
      storeOpenMs, startupPlusFirstSnapshotMs: round(storeOpenMs + warm.wallMs), warm,
      ...(workload === "compaction-control" ? {
        compaction: { initial: firstCompaction, unchanged: groupSummary("unchanged"), oneChange: groupSummary("one-change") },
      } : {}),
      operations,
      wallMs: summary(operations.map(row => row.wallMs)), readBytes: summary(operations.map(row => row.readBytes)),
      allocatedHeapPeakBytes: summary(operations.map(row => row.allocatedHeapPeakBytes)),
      peakHeapBytes, loopGapMs: summary(gaps), gapsOver50Ms: gaps.filter(gap => gap > 50).length,
      viewerGapsOver500Ms: summary(loggedGaps) });
  } finally {
    compactionRegistry?.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const report = { schemaVersion: 1, label, runtime: Bun.version, at: new Date().toISOString(),
  input: { sha256: inputSha256 },
  sourceHashes,
  load: { iterations: count, compactionNoChangeTicks: 3, compactionChangedTicks: 3,
    pauseBeforeMs: 25, pauseAfterMs: 15, timerMs: 10, writerProcesses: 1,
    heapMetric: "process.memoryUsage().heapUsed peak sampled during the first snapshot, payload reads and operations",
    allocationMetric: "peak live JavaScriptCore heap growth over the pre-operation heapSize baseline, sampled every 512 payload parses and at operation end; this captures concurrent heap pressure, while cumulative allocation volume remains unmeasured",
    logicalNow: new Date(logicalNow).toISOString(),
    scope: "Viewer registry executor and Viewer loop monitor in isolation; no browser or whole-application traffic" }, results };
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
