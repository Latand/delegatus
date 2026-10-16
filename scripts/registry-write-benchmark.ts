import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { normalizeRegistry } from "../src/lib/agent/registry";
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
const readBytes = () => Number(fs.readFileSync("/proc/self/io", "utf8").match(/^rchar:\s+(\d+)/m)![1]);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const workloads = ["keyed", "writer-snapshot", "serialized-snapshot", "keyed-with-snapshot", "compaction-control"] as const;
const results: unknown[] = [];
const logicalNow = Date.parse("2026-10-16T08:00:00.000Z");
const sourceFiles = ["src/lib/agent/sqliteRegistryStore.ts", "src/lib/agent/registry.ts", "src/lib/performanceSpans.ts", "scripts/registry-write-benchmark.ts"];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash("sha256").update(fs.readFileSync(new URL(`../${file}`, import.meta.url))).digest("hex")]));

for (const workload of workloads) {
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
  let measuring = false;
  let peakHeapBytes = 0;
  const sampleHeap = () => { if (measuring) peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed); };
  const store = new SqliteAgentRegistryStore(filename, {
    normalize: normalizeRegistry, initialSnapshot: () => { throw new Error("offline input must already be imported"); },
    onRowPayloadRead: (_collection, amount) => { payloadReads += amount; if (amount >= 256) sampleHeap(); },
    onRowPayloadParse: (_collection, amount) => { parsed += amount; if (parsed >= 2048) { parsed = 0; sampleHeap(); } },
  });
  const gaps: number[] = [];
  const loggedGaps: number[] = [];
  const monitor = createViewerLoopMonitor(line => {
    if (line.startsWith("[viewer loop-gap] ")) loggedGaps.push(JSON.parse(line.slice("[viewer loop-gap] ".length)).gapMs);
  });
  try {
    const warmStarted = performance.now();
    const warmBytes = readBytes();
    store.snapshot();
    const warm = { wallMs: round(performance.now() - warmStarted), readBytes: readBytes() - warmBytes, payloadReads };
    Bun.gc(true);
    payloadReads = 0;
    measuring = true;
    sampleHeap();
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      gaps.push(Math.max(0, now - last - 10));
      last = now;
    }, 10);
    const operations: Array<{ wallMs: number; readBytes: number; payloadReads: number }> = [];
    monitor.start();
    try {
      const iterations = workload === "compaction-control" ? 2 : count;
      for (let iteration = 0; iteration < iterations; iteration++) {
        await sleep(25);
        const beforeReads = payloadReads;
        const beforeBytes = readBytes();
        const start = performance.now();
        if (workload === "writer-snapshot") store.snapshot();
        else if (workload === "serialized-snapshot") {
          const serialized = JSON.stringify(store.snapshot().file);
          if (!serialized.length) throw new Error("snapshot serialization was empty");
        }
        else if (workload === "compaction-control") {
          // The same public domain operation as the earlier research. The
          // method intentionally scans candidates and is a separate control.
          const { AgentRegistry } = await import("../src/lib/agent/registry");
          const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
            sqliteMode: "sqlite", now: () => logicalNow,
            onSqliteRowPayloadRead: (_collection, amount) => { payloadReads += amount; if (amount >= 256) sampleHeap(); },
            onSqliteRowPayloadParse: (_collection, amount) => { parsed += amount; if (parsed >= 2048) { parsed = 0; sampleHeap(); } },
          });
          try { await registry.deliveryWrite({ label: "benchmark.compaction" }, () => registry.compactDeliveryReservations()); }
          finally { registry.close(); }
        } else {
          await store.withWriter(() => store.mutate(file => {
            file.receipts[key]!.error = `benchmark change ${iteration}`;
          }, workload === "keyed-with-snapshot"));
        }
        operations.push({ wallMs: round(performance.now() - start), readBytes: readBytes() - beforeBytes, payloadReads: payloadReads - beforeReads });
        sampleHeap();
        // Let the independent timer observe each synchronous operation.
        await sleep(15);
      }
    } finally {
      monitor.stop();
      clearInterval(timer);
    }
    results.push({ workload, rows: rows.count, payloadBytes: rows.bytes, coldRows: cold, warm, operations,
      wallMs: summary(operations.map(row => row.wallMs)), readBytes: summary(operations.map(row => row.readBytes)),
      peakHeapBytes, loopGapMs: summary(gaps), gapsOver50Ms: gaps.filter(gap => gap > 50).length,
      viewerGapsOver500Ms: summary(loggedGaps) });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const report = { schemaVersion: 1, label, runtime: Bun.version, at: new Date().toISOString(),
  sourceHashes,
  load: { iterations: count, pauseBeforeMs: 25, pauseAfterMs: 15, timerMs: 10, writerProcesses: 1,
    heapMetric: "process.memoryUsage().heapUsed sampled at batch reads, every 2048 parsed rows and after operations",
    logicalNow: new Date(logicalNow).toISOString(),
    scope: "Viewer registry executor and Viewer loop monitor in isolation; no browser or whole-application traffic" }, results };
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
