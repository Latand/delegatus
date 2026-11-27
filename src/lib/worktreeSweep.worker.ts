import { withAttemptTempDeadline, sweepMonotonicNow } from "./runtime/attemptTempDeadline";
import { runTempSweepInHelper, scanProcesses } from "./tempSweep";
import { runAttemptTempSweep } from "./runtime/attemptTempProduction";
import { runApprovedAttemptTempSweep } from "./runtime/attemptTempApproved";
import { runTemporaryDataSweep } from "./runtime/temporaryDataProduction";
import { pruneDockerCache } from "./dockerCacheRetention";
import { tempSweepMode } from "./tempSweep";
import { readDiskPressureInHelper } from "./state/diskPressure";
import { createInterface } from "node:readline";
import { statePath } from "./configDir";
import { waitForStateLock } from "./state/lockWait";
import { SweepWalkDeferred, sweepPressureCheckpoint, withSweepWalk } from "./pipelines/sweepWalkAdmission";
import { WorktreeSweepDiscovery } from "./pipelines/worktreeSweepDiscovery";
import { WorktreeSweepCache } from "./pipelines/worktreeSweepCache";
import { productionWorktreeSweepPorts, runWorktreeSweep } from "./pipelines/worktreeSweep";
import type { SweepRequest } from "./pipelines/worktreeSweepWorker";

// stdout is a bounded response protocol; application diagnostics keep their origin.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);
let cache: WorktreeSweepCache | undefined;
let discovery: WorktreeSweepDiscovery | undefined;
const lines = createInterface({ input: process.stdin });
const reply = (report: unknown) => {
  process.stdout.write(JSON.stringify({ report, recycle: process.memoryUsage.rss() >= 256 * 1024 ** 2 }) + "\n");
};
for await (const line of lines) {
  try {
    if (line.length > 8192) throw new Error("worktree sweep request exceeded its bound");
    const request = JSON.parse(line) as SweepRequest & { deadline: number };
    if (request.kind === "disk-pressure") {
      reply(await readDiskPressureInHelper({ probeOnly: true }));
      continue;
    }
    if (request.kind === "memory") {
      const { readHostMemoryReading } = await import("./state/hostTmpUsage");
      reply(await readHostMemoryReading());
      continue;
    }
    if (!Number.isFinite(request.deadline)) throw new Error("invalid sweep request deadline");
    const report = await withSweepWalk(request.deadline, () => {
      const pause = sweepPressureCheckpoint(request.kind === "worktrees");
      return withAttemptTempDeadline(request.deadline, () => runSweep(request, () => pause(sweepMonotonicNow())), pause);
    });
    reply(report);
  } catch (error) {
    const response = error instanceof SweepWalkDeferred ? { deferred: error.reason }
      : { error: error instanceof Error ? error.message : String(error) };
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}
cache?.close();

async function runSweep(request: Exclude<SweepRequest, { kind: "disk-pressure" | "memory" }> & { deadline: number }, pause: () => boolean) {
  if (request.kind === "disk-cleaner") {
    const { runCleanerSweep } = await import("./cleaner/diskSweep");
    return runCleanerSweep(request.sweep);
  }
  if (request.kind === "maintenance") {
    // Maintenance consumers use calendar deadlines; only this boundary converts.
    request.deadline = Date.now() + (request.deadline - sweepMonotonicNow());
    const mode = tempSweepMode();
    if (!mode || !Number.isFinite(request.deadline) || Date.now() >= request.deadline - 1000) {
      return null;
    }
    // The host Docker daemon is shared across isolated state directories.
    // Test workers always use Docker dry-run mode.
    await pruneDockerCache({ mode: process.env.NODE_ENV === "test" ? "dry-run" : mode,
      deadline: Math.min(request.deadline - 1000, Date.now() + 22000) });
    return runTemporaryDataSweep({ scan: directories => scanProcesses("/proc", directories) }, process.env, request.deadline - 1000);
  }
  if (request.kind === "attempt-temp-approved") {
    return runApprovedAttemptTempSweep(request.approval, { scan: directories => scanProcesses("/proc", directories) });
  }
  if (request.kind === "attempt-temp") {
    return runAttemptTempSweep({ scan: directories => scanProcesses("/proc", directories) });
  }
  if (request.kind === "temp") {
    return runTempSweepInHelper({ ...process.env, LLV_TEMP_SWEEP: request.env?.LLV_TEMP_SWEEP,
      LLV_TEMP_SWEEP_MAX_AGE_HOURS: request.env?.LLV_TEMP_SWEEP_MAX_AGE_HOURS,
      LLV_TEMP_STRAY_MAX_AGE_HOURS: request.env?.LLV_TEMP_STRAY_MAX_AGE_HOURS, LLV_TEMP_STRAY_KEEP: request.env?.LLV_TEMP_STRAY_KEEP });
  }
  if (request.kind === "disk-consumers") {
    await readDiskPressureInHelper({ measureOnly: true, deadline: request.deadline });
    return null;
  }
  if (request.kind !== "worktrees") throw new Error("invalid sweep request kind");
  if (!cache) {
    cache = new WorktreeSweepCache(statePath("worktree-sweep-cache.json"));
    cache.discardAllocations();
  }
  const passCache = cache, passDiscovery = discovery ??= new WorktreeSweepDiscovery();
  const { mode } = request;
  if (mode !== "on" && mode !== "dry-run") throw new Error("invalid worktree sweep mode");
  process.stdout.write(JSON.stringify({ phase: "discovery" }) + "\n");
  const report = await runWorktreeSweep({ LLV_WORKTREE_SWEEP: mode }, async mode => {
    const ports = await waitForStateLock("worktrees.sweep.inputs", () => productionWorktreeSweepPorts(mode));
    let previousPhase = "";
    return { ...ports, cache: passCache, discovery: passDiscovery, pause, phase: (phase: string) => {
      if (phase === previousPhase) return;
      previousPhase = phase;
      process.stdout.write(JSON.stringify({ phase }) + "\n");
    } };
  });
  passCache.persist();
  return report;
}
