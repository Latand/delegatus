import { runTempSweepInHelper, scanProcesses } from "./tempSweep";
import { runAttemptTempSweep } from "./runtime/attemptTempProduction";
import { readDiskPressureInHelper } from "./state/diskPressure";
import { createInterface } from "node:readline";
import { statePath } from "./configDir";
import { waitForStateLock } from "./state/lockWait";
import { WorktreeSweepCache } from "./pipelines/worktreeSweepCache";
import { productionWorktreeSweepPorts, runWorktreeSweep, type WorktreeSweepMode } from "./pipelines/worktreeSweep";

// stdout is a bounded response protocol; application diagnostics keep their origin.
console.log = (...args) => console.error(...args);
const cache = new WorktreeSweepCache(statePath("worktree-sweep-cache.json"));
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  try {
    if (line.length > 1024) throw new Error("worktree sweep request exceeded its bound");
    const request = JSON.parse(line);
    if (request.kind === "attempt-temp") {
      const report = await runAttemptTempSweep({ scan: directories => scanProcesses("/proc", directories) });
      process.stdout.write(JSON.stringify({ report }) + "\n");
      continue;
    }
    if (request.kind === "temp") {
      const report = await runTempSweepInHelper({ ...process.env, LLV_TEMP_SWEEP: request.env?.LLV_TEMP_SWEEP,
        LLV_TEMP_SWEEP_MAX_AGE_HOURS: request.env?.LLV_TEMP_SWEEP_MAX_AGE_HOURS });
      process.stdout.write(JSON.stringify({ report }) + "\n");
      continue;
    }
    if (request.kind === "disk-pressure") {
      const report = await readDiskPressureInHelper();
      process.stdout.write(JSON.stringify({ report }) + "\n");
      continue;
    }
    if (request.kind !== "worktrees") throw new Error("invalid sweep request kind");
    const { mode } = request as { mode: WorktreeSweepMode };
    if (mode !== "on" && mode !== "dry-run") throw new Error("invalid worktree sweep mode");
    const report = await runWorktreeSweep({ LLV_WORKTREE_SWEEP: mode }, async mode => {
      const ports = await waitForStateLock("worktrees.sweep.inputs", () => productionWorktreeSweepPorts(mode));
      return { ...ports, cache };
    });
    cache.persist();
    process.stdout.write(JSON.stringify({ report }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
  }
}
cache.close();
