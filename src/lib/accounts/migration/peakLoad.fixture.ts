import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { AgentRegistry } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, REGISTRY_PERFORMANCE_SHAPE } from "@/lib/agent/registryPerformanceDataset";
import { reconcileMigrations } from "./coordinator";
import type { SuccessorProviderPort } from "./contracts";

/** Recorded census, synthetic payloads. The diagnostic pending cap is separate
 * from the eight open deliveries observed in the retained production census.
 * The stress variant uses 128 open rows, with the same settled history. */
export const PEAK_LOAD_SHAPE = { ...REGISTRY_PERFORMANCE_SHAPE,
  conversations: 22_538, entries: 56, workers: 56, activeEntries: 0,
  receipts: 256, heldDeliveries: 34_088, deliveryOperationOwners: 34_088,
  lineageEdges: 0, memberships: 0, migrationIntents: 0,
  pendingDeliveries: 0, uncertainDeliveries: 128, outstandingReceipts: 0,
  transcripts: 0, hotTerminalRows: 34_088,
};

export const noSuccessor: SuccessorProviderPort = {
  async create() { throw new Error("fixture must not create a successor"); },
  async verify() {},
};

export function peakLoadFixture(directory: string) {
  return buildRegistryPerformanceDataset(directory, PEAK_LOAD_SHAPE);
}

function recordedRows(filename: string): string {
  const db = new Database(filename, { readonly: true });
  const hash = createHash("sha256");
  try {
    for (const row of db.query("SELECT collection,row_key,value_json,row_order FROM registry_rows ORDER BY collection,row_key").iterate())
      hash.update(JSON.stringify(row)).update("\n");
    return hash.digest("hex");
  } finally { db.close(); }
}

// A reusable offline measurement entry point. The caller owns this directory,
// interpreter profile and isolation. Reopening the recorded file changes no row.
if (import.meta.main) {
  const [directory, duration = "0", mode] = process.argv.slice(2);
  if (!directory) throw new Error("supply a private recorded-fixture directory");
  const manifest = path.join(directory, "manifest.json");
  if (!fs.existsSync(manifest)) {
    const made = peakLoadFixture(directory);
    fs.writeFileSync(manifest, JSON.stringify({ shape: PEAK_LOAD_SHAPE, filename: path.basename(made.filename), rows: made.rows,
      bytes: made.payloadBytes, sha256: createHash("sha256").update(fs.readFileSync(made.filename)).digest("hex") }));
  }
  const record = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteFilename: path.join(directory, record.filename),
  });
  const rowsBefore = recordedRows(path.join(directory, record.filename));
  const samples: number[] = [];
  const passSamples: number[] = [];
  const passCounts: number[] = [];
  let observations = 0;
  const observe = mode === "--observe";
  const expected = record.shape.pendingDeliveries + record.shape.uncertainDeliveries;
  const delivery = { async deliver(): Promise<never> { throw new Error("fixture must not dispatch"); },
    actuates: () => { observations++; return false; },
    ...(observe ? { async reconcileUncertain(): Promise<never> { throw new Error("fixture must not actuate"); } } : {}),
  };
  const started = performance.now();
  try {
    do {
      const at = performance.now();
      const before = observations;
      let passes = 0;
      do {
        const passAt = performance.now();
        await reconcileMigrations(noSuccessor, delivery, registry);
        passSamples.push(performance.now() - passAt);
        passes++;
      } while (observe && observations - before < expected && passes < 10);
      if (observe && observations - before !== expected) throw new Error("observation sweep did not cover the recorded open rows exactly once");
      passCounts.push(passes);
      samples.push(performance.now() - at);
      // Keep the controller's cadence independent of the cost of its pass.
      if (Number(duration)) await new Promise(resolve => setTimeout(resolve, 100));
    } while (samples.length < 5 || performance.now() - started < Number(duration));
    const elapsedMs = performance.now() - started;
    const rss = process.memoryUsage().rss;
    const rowsAfter = recordedRows(path.join(directory, record.filename));
    if (rowsBefore !== rowsAfter) throw new Error("measurement changed the recorded registry rows");
    console.log(JSON.stringify({ fixture: record, rowsBefore, rowsAfter, mode: observe ? "open-row-sweep" : "idle-pass",
      samples, passSamples, passCounts, observations, elapsedMs, rss }));
  } finally { registry.close(); }
}
