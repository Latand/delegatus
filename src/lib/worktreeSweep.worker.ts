import { runTempSweepInHelper, scanProcesses } from "./tempSweep";
import { runAttemptTempSweep } from "./runtime/attemptTempProduction";
import { runTemporaryDataSweep } from "./runtime/temporaryDataProduction";
import { pruneDockerCache } from "./dockerCacheRetention";
import { tempSweepMode } from "./tempSweep";
import { readDiskPressureInHelper } from "./state/diskPressure";
import { createInterface } from "node:readline";
import { statePath } from "./configDir";
import { waitForStateLock } from "./state/lockWait";
import { WorktreeSweepCache } from "./pipelines/worktreeSweepCache";
import { productionWorktreeSweepPorts, runWorktreeSweep, type WorktreeSweepMode } from "./pipelines/worktreeSweep";

// stdout is a bounded response protocol; application diagnostics keep their origin.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);
const cache = new WorktreeSweepCache(statePath("worktree-sweep-cache.json"));
cache.discardAllocations();
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  try {
    if (line.length > 1024) throw new Error("worktree sweep request exceeded its bound");
    const request = JSON.parse(line);
    if (request.kind === "maintenance") {
      const mode = tempSweepMode();
      if (!mode || !Number.isFinite(request.deadline) || Date.now() >= request.deadline - 1000) {
        process.stdout.write(JSON.stringify({ report: null }) + "\n"); continue;
      }
      // The host Docker daemon is shared across isolated state directories.
      // Test workers always use Docker dry-run mode.
      await pruneDockerCache({ mode: process.env.NODE_ENV === "test" ? "dry-run" : mode,
        deadline: Math.min(request.deadline - 1000, Date.now() + 22000) });
      const report = await runTemporaryDataSweep({ scan: directories => scanProcesses("/proc", directories) }, process.env, request.deadline - 1000);
      process.stdout.write(JSON.stringify({ report }) + "\n"); continue;
    }
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
    process.stdout.write(JSON.stringify({ phase: "discovery" }) + "\n");
    const report = await runWorktreeSweep({ LLV_WORKTREE_SWEEP: mode }, async mode => {
      const ports = await waitForStateLock("worktrees.sweep.inputs", () => productionWorktreeSweepPorts(mode));
      let previousPhase = "";
      return { ...ports, cache, phase: (phase: string) => {
        if (phase === previousPhase) return;
        previousPhase = phase;
        process.stdout.write(JSON.stringify({ phase }) + "\n");
      } };
    });
    cache.persist();
    process.stdout.write(JSON.stringify({ report }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
  }
}
cache.close();
