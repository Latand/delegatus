/** Reproducible synthetic read attribution. Requires an explicitly isolated
 * LLV_STATE_DIR; never opens a serving installation. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { initializeStateCollections, readStateCollectionRows } from "../src/lib/state/sqliteStateStore";
import { buildRegistryPerformanceDataset, REGISTRY_PERFORMANCE_SHAPE, scaledRegistryPerformanceShape } from "../src/lib/agent/registryPerformanceDataset";
import { normalizeRegistry } from "../src/lib/agent/registry";
import { SqliteAgentRegistryStore } from "../src/lib/agent/sqliteRegistryStore";
import { readAttribution } from "../src/lib/readAttribution";
import { performanceSpans } from "../src/lib/performanceSpans";
import { viewerLoopMonitor, withViewerOperation } from "../src/lib/viewerLoopMonitor";
import { isOperatorOwnedDirectory } from "../src/lib/stateOwnership";

const directory = process.env.LLV_STATE_DIR;
if (!directory || !process.env.HOME || !process.env.XDG_CONFIG_HOME || !process.env.TMPDIR
  || isOperatorOwnedDirectory(directory)) {
  throw new Error("Set isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR");
}
const output = process.argv[2];
if (!output) throw new Error("Pass an output JSON filename");
const scale = Number(process.env.LLV_READ_SCENARIO_SCALE ?? 1);
if (!(scale > 0 && scale <= 1)) throw new Error("scale must be in (0,1]");
fs.mkdirSync(directory, { recursive: true });
const fixture = fs.mkdtempSync(path.join(directory, "read-attribution-"));
readAttribution.setEnabled(false);
const filename = path.join(fixture, "state.sqlite");
const shape = [{ collection: "pipelines", count: 262, bytes: 30_000_000 },
  { collection: "pipelines_archive", count: 796, bytes: 90_000_000 }].map(row => ({ ...row, count: Math.max(1, Math.round(row.count * scale)), bytes: Math.round(row.bytes * scale) }));
initializeStateCollections(filename, shape.map(({ collection, count, bytes }) => ({ collection, schemaVersion: 1,
  migrationId: "read-attribution-v1", key: (row: unknown) => (row as { id: string }).id,
  loadRecords: () => Array.from({ length: count }, (_, index) => ({ id: `record-${index}`, payload: "p".repeat(Math.floor(bytes / count)) })) })));
const dataset = buildRegistryPerformanceDataset(path.join(fixture, "registry"), scale === 1 ? REGISTRY_PERFORMANCE_SHAPE : scaledRegistryPerformanceShape(scale));
const registry = new SqliteAgentRegistryStore(dataset.filename, { normalize: normalizeRegistry,
  initialSnapshot: () => { throw new Error("fixture is already seeded"); } });
const cases = [
  { name: "pipelines", operation: "pipelines.get" as const, run: () => readStateCollectionRows(filename, "pipelines")?.length ?? 0 },
  { name: "pipelines_archive", operation: "pipelines.get" as const, run: () => readStateCollectionRows(filename, "pipelines_archive")?.length ?? 0 },
  { name: "registry.snapshot", operation: "registry.prepare" as const, run: () => Object.keys(registry.snapshot().file.entries).length },
  { name: "deliveryOperationOwners", operation: "registry.prepare" as const, run: () => {
    const reader = new SqliteAgentRegistryStore(dataset.filename, { normalize: normalizeRegistry, readOnly: true,
      initialSnapshot: () => { throw new Error("fixture is already seeded"); } });
    try { return Object.keys(reader.readOnlySnapshot().file.deliveryOperationOwners).length; }
    finally { reader.close(); }
  } },
];
const reports: unknown[] = [], gaps: Array<{ gapMs: number; reads: ReturnType<typeof readAttribution.snapshot> }> = [];
const restore = viewerLoopMonitor.setLogSink(line => {
  if (line.startsWith("[viewer loop-gap] ")) gaps.push(JSON.parse(line.slice("[viewer loop-gap] ".length)));
});
try {
  for (const subject of cases) {
    const timings = [];
    // AB/BA paired samples on identical data; this measures the incremental
    // counter cost (the connection decorators exist in both modes).
    for (let pair = 0; pair < 3; pair++) {
      const values: Record<string, number> = {};
      for (const enabled of pair % 2 ? [true, false] : [false, true]) {
        readAttribution.setEnabled(enabled); readAttribution.clear(); performanceSpans.clear();
        const start = performance.now(); subject.run(); values[enabled ? "enabledMs" : "disabledMs"] = performance.now() - start;
      }
      timings.push(values);
    }
    readAttribution.setEnabled(true); readAttribution.clear(); performanceSpans.clear();
    viewerLoopMonitor.start();
    await Bun.sleep(50);
    const before = gaps.length, start = performance.now();
    let iterations = 0, rows = 0;
    do {
      // Deliberately use the existing public operation entry point; SQLite
      // readers and JSON parsers below it supply the concrete reader names.
      rows += withViewerOperation(subject.operation, subject.run); iterations++;
    } while (performance.now() - start < 750);
    await Bun.sleep(30);
    viewerLoopMonitor.stop();
    const window = gaps.slice(before);
    const pauseMs = window.reduce((sum, gap) => sum + gap.gapMs, 0);
    const attributedMs = window.reduce((sum, gap) => sum + Math.min(gap.gapMs, gap.reads.namedSyncMs), 0);
    const fraction = pauseMs ? attributedMs / pauseMs : 0;
    reports.push({ name: subject.name, iterations, rows, pauseMs, attributedMs, attributedFraction: fraction, timings,
      gaps: window.map(({ gapMs, reads }) => ({ gapMs, reads })) });
  }
  const sources = ["src/lib/readAttribution.ts", "src/lib/sqliteReadAttribution.ts", "src/lib/viewerLoopMonitor.ts",
    "src/lib/performanceSpans.ts", "src/lib/state/sqliteStateStore.ts", "src/lib/agent/sqliteRegistryStore.ts", "scripts/benchmark-read-attribution.ts"];
  const hashes = Object.fromEntries(sources.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ schema: 1, utc: new Date().toISOString(), runtime: Bun.version, platform: process.platform,
    command: "bun scripts/benchmark-read-attribution.ts evidence/read-attribution/local.json", scale,
    sourceHashes: hashes, shape, registry: { rows: dataset.rows, payloadBytes: dataset.payloadBytes, shape: dataset.shape }, reports }, null, 2) + "\n");
  if (gaps.length < cases.length || gaps.some(gap => gap.reads.attributedFraction < 0.8 || gap.reads.decodedJsonBytes === 0 || gap.reads.readBytes === 0)) {
    throw new Error("local read attribution did not meet the 80% acceptance threshold; inspect the saved report");
  }
  console.log(JSON.stringify(reports.map(row => { const { name, pauseMs, attributedFraction } = row as { name: string; pauseMs: number; attributedFraction: number }; return { name, pauseMs, attributedFraction }; })));
} finally {
  viewerLoopMonitor.stop(); restore(); registry.close(); readAttribution.clear();
}
