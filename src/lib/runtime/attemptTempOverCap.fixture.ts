/* One process of an upgraded installation, started by
 * `attemptTempOverCap.test.ts` under an operator-shaped home. The caller names
 * the process owner in the environment, as each real entry point does. */
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { AgentRegistry } from "@/lib/agent/registry";
import { pipelineIdentity, savePipelines } from "@/lib/pipelines/store";
import { startCurrentReleaseControllers } from "@/lib/viewerInstrumentation";
import { attemptReferencesClear } from "./attemptTempFilesystem";
import { runAttemptTempSweep } from "./attemptTempProduction";
import { AttemptTempStore } from "./attemptTempRetention";
import { finishedLane } from "./attemptTempRetention.testSupport";

const [mode, value, repo, size] = process.argv.slice(2);
const NOW = Date.parse("2035-01-15T00:00:00Z"), HOUR = 3600_000;
Date.now = () => NOW;
let answer: unknown;

if (mode === "--seed-previous-release") {
  // A lane whose one attempt ended `value` hours ago, holding an unreleased stage root.
  const completedAt = new Date(NOW - Number(value) * HOUR).toISOString(), base = finishedLane(repo!, completedAt), id = "lane-upgraded";
  savePipelines([{ ...base, ...pipelineIdentity(id, base.task, repo!), id, repoDir: repo!,
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: id, effectiveRole: base.stages[0]!.effectiveRole,
      conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null, startedAt: completedAt, completedAt,
      input: null, activatedBy: null, output: null, verdict: null, error: null }] }] }]);
  new AgentRegistry(statePath("agent-registry.json"), () => false, undefined, { sqliteMode: "sqlite" }).close();
  const directory = statePath("scratch", "llv-stage-upgrad");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bytes = Number(size ?? 1024 ** 2);
  fs.writeFileSync(`${directory}/payload`, Buffer.alloc(bytes, 7));
  const ledger = new AttemptTempStore();
  try {
    ledger.register({ directory, pipelineId: id, launchId: id, retainUntilClose: false, createdAt: Date.parse(completedAt) - HOUR });
    ledger.measure(directory, bytes);
  } finally { ledger.close(); }
  // The previous release's ledger: every table of this one but the over-cap
  // position.
  const database = new Database(statePath("attempt-temp.sqlite"));
  try {
    database.exec("DROP TABLE IF EXISTS over_cap_cursor");
    answer = { directory, tables: database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name) };
  } finally { database.close(); }
} else if (mode === "--viewer-start") {
  // The serving Viewer's own startup, with every clock but the temp sweep left
  // out and that one never started.
  await startCurrentReleaseControllers({ LLV_ACCOUNT_CONTROLLER_DISABLED: "1" }, {
    loadFlowPipelineController: async () => ({ startFlowPipelineController: () => {} }),
    loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
    loadTempSweep: async () => ({ startTempSweep: () => {} }),
  });
  answer = {};
} else if (mode === "--record-starved-report") {
  fs.mkdirSync(path.dirname(statePath("attempt-temp-report.json")), { recursive: true });
  fs.writeFileSync(statePath("attempt-temp-report.json"), JSON.stringify({
    at: new Date(NOW).toISOString(), condition: { mode: "on", overCap: true, failing: false },
    overCap: { checked: 0, ended: "budget", capBytes: Number(value ?? 1) },
  }));
  answer = {};
} else if (mode === "--minute-tick") {
  answer = await runAttemptTempSweep({ scan: () => ({ ownNamespace: null, processes: [] }),
    references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true),
    availableBytes: () => 531e9 }, { ...process.env, LLV_TEMP_SWEEP: "on", LLV_ATTEMPT_TEMP_CAP_BYTES: value! });
} else if (mode === "--minute-tick-low-space") {
  answer = await runAttemptTempSweep({ scan: () => ({ ownNamespace: null, processes: [] }),
    references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true),
    availableBytes: () => 19 * 1024 ** 3 }, { ...process.env, LLV_TEMP_SWEEP: "on", LLV_ATTEMPT_TEMP_CAP_BYTES: value! });
} else throw new Error(`unknown mode: ${mode}`);

process.stdout.write(JSON.stringify({ answer, report: statePath("attempt-temp-report.json") }) + "\n", () => process.exit(0));
