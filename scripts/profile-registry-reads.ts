/** Run on an isolated COPY of state, through gate-slot.sh. Never pass live
 * state. Compare the same driver/data with the base and candidate exports.
 * The closed Viewer control URL prevents delegation to a running installation.
 * Prints only aggregate measurements, never row identities or command text. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { AgentRegistry, setAgentRegistryForTests } from "../src/lib/agent/registry";
import { readAttribution } from "../src/lib/readAttribution";
import { withViewerOperation } from "../src/lib/viewerLoopMonitor";
import { resolveOrchestratorRelay } from "../src/lib/orchestrator/relay";
import { activeOrchestratorSeats } from "../src/lib/orchestrator/seats";
import { authorizedManagerSeats } from "../src/lib/orchestrator/authority";
import { productionManagerAuthoritySources } from "../src/lib/orchestrator/managerAuthoritySources";

const directory = process.env.LLV_STATE_DIR;
assert(directory && process.env.LLV_VIEWER_CONTROL_URL === "http://127.0.0.1:1", "isolated state and closed control URL required");
assert(fs.existsSync(path.join(directory, ".registry-read-profile-copy")), "copy marker required");
const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined,
  { sqliteMode: "sqlite", sqliteFilename: path.join(directory, "agent-registry.sqlite"), deferColdKeyInitialization: true });
setAgentRegistryForTests(registry);
const { Database } = await import("bun:sqlite");
const db = new Database(path.join(directory, "agent-registry.sqlite"), { readonly: true });
const corpus = db.query("SELECT collection,COUNT(*) AS rows,SUM(LENGTH(CAST(value_json AS BLOB))) AS bytes FROM registry_rows GROUP BY collection").all();
db.close();
const seat = activeOrchestratorSeats()[0];
assert(seat?.conversationId, "populated seat required");
await registry.prepareReadOnlySnapshot();
async function measure(name: string, run: number, work: () => unknown) {
  readAttribution.clear();
  const load = os.loadavg();
  const start = performance.now();
  const cpu = process.cpuUsage();
  const result = await withViewerOperation("http.render", work);
  const durationMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const reads = readAttribution.snapshot(durationMs);
  assert.equal(reads.dropped, 0, "attribution rows dropped");
  const registryReads = reads.top.filter(row => row.reader === "registry.json");
  const calls = registryReads.reduce((sum, row) => sum + row.calls, 0);
  const bytes = registryReads.reduce((sum, row) => sum + row.decodedJsonBytes, 0);
  // Bytes in the complete operation totals prove no registry decode row was
  // dropped from the top list. Other state readers are reported separately.
  assert(bytes <= reads.decodedJsonBytes);
  const item = { name, run, durationMs, cpuMs: (used.user + used.system) / 1000, load,
    registryCalls: calls, registryBytes: bytes, allDecodedBytes: reads.decodedJsonBytes,
    attributionOmitted: reads.omitted, callsPerMinuteAtSix: calls * 6, bytesPerMinuteAtSix: bytes * 6 };
  console.log(JSON.stringify(item));
  return result;
}
const relay = () => {
  const answer = resolveOrchestratorRelay(seat.project, undefined, { text: "Profile missing key", origin: { kind: "operator" } },
    "Profile missing key", "profile-registry-absent-key");
  assert(answer.ok, "relay did not resolve a recipient");
};
const authority = () => {
  const answer = authorizedManagerSeats(productionManagerAuthoritySources(registry));
  assert(answer.length > 0, "authority fixture is empty");
};
// Cold-after-preparation and two unchanged calls, then the same six-poll load.
for (let run = 1; run <= 3; run++) await measure("relay", run, relay);
for (let run = 1; run <= 3; run++) await measure("authority", run, authority);
const gaps: number[] = [];
let previous = performance.now();
const timer = setInterval(() => {
  const now = performance.now(); gaps.push(Math.max(0, now - previous - 10)); previous = now;
}, 10);
const start = performance.now();
try {
  // Six polls at the browser fallback cadence. The timer records the actual
  // one-minute event-loop window, including scheduling noise under host load.
  for (let poll = 0; poll < 6; poll++) {
    await measure("poll-relay", poll + 1, relay);
    await measure("poll-authority", poll + 1, authority);
    await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, start + (poll + 1) * 10_000 - performance.now())));
  }
} finally { clearInterval(timer); }
const windowMs = performance.now() - start;
const gapMs = gaps.filter(gap => gap > 500).reduce((sum, gap) => sum + gap, 0);
console.log(JSON.stringify({ name: "poll-loop", windowMs, gapMs, maxGapMs: Math.max(0, ...gaps),
  gapShare: gapMs / windowMs, thresholdMs: 500, corpus, cpus: os.availableParallelism() }));
if (process.argv.includes("--routes")) {
  const data = JSON.parse(fs.readFileSync(path.join(directory, "files-scan-snapshot.json"), "utf8")).snapshot;
  const { setFileScanRunnerForTests, setFileCatalogMembershipProbeForTests } = await import("../src/lib/scanner/scanCache");
  setFileScanRunnerForTests(async () => structuredClone(data));
  setFileCatalogMembershipProbeForTests(async () => null);
  const { GET } = await import("../src/app/api/files/operatorProjection");
  for (let run = 1; run <= 3; run++) {
    const response = await measure("summary-bootstrap", run, () => GET(new Request("http://localhost/api/files?view=summary"), () => {}));
    assert(response instanceof Response && response.status === 200 && response.headers.get("x-llv-files-projection-cache") === "bootstrap");
    await response.body?.cancel();
  }
  const React = await import("react");
  const { renderToString } = await import("react-dom/server");
  const { default: Home } = await import("../src/app/page");
  for (let run = 1; run <= 3; run++) {
    const html = await measure("home-html", run, () => renderToString(React.createElement(Home)));
    assert(typeof html === "string" && html.length > 0);
  }
}
registry.close();
setAgentRegistryForTests(null);
process.exit(0);
