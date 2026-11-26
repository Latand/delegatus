import fs from "node:fs";
import type { CleanerController } from "@/lib/cleaner/run";
import { statePath } from "@/lib/configDir";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { readDiskPressure } from "./diskPressure";
import { productionDiskPressureActions, productionMemoryPressureActions, reconcileDiskPressure, type DiskPressureActions } from "./diskPressureActions";
import { observeMemoryPressureReport, readMemoryReading, reconcileMemoryPressure, type MemoryPressureActions } from "./memoryPressure";

const host = globalThis as typeof globalThis & { __delegatusDiskPressureTimer?: ReturnType<typeof setTimeout> };

function releaseTrafficSince(now: number): number | null {
  if (!process.env.PORT?.trim()) return null;
  let file: number | undefined;
  try {
    file = fs.openSync(statePath("viewer-release.json"), "r");
    // Promotion atomically replaces this target. Read the target and its
    // timestamp from the same inode, including on a Viewer process restart.
    if (viewerReleaseOwnsTraffic(process.env, () => fs.readFileSync(file!, "utf8"))) {
      return Math.min(now, fs.fstatSync(file).mtimeMs);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (file !== undefined) fs.closeSync(file);
  }
}

/** The release-owning startup calls this even when automatic cleanup is off.
 * Pressure remains observable without an open browser or an enabled seat. */
export function startDiskPressureWatch(ports: {
  observe?: () => Promise<unknown>;
  schedule?: typeof setTimeout;
  readPressure?: typeof readDiskPressure;
  actions?: DiskPressureActions;
  cleaner?: CleanerController;
  now?: () => number;
  memoryActions?: MemoryPressureActions;
} = {}): void {
  if (host.__delegatusDiskPressureTimer || (!ports.observe && process.env.LLV_STATE_OWNER !== "viewer")) return;
  const cleaner = ports.cleaner;
  const actions = ports.actions ?? productionDiskPressureActions();
  const now = ports.now ?? Date.now;
  const watchStartedAt = now();
  let trafficSince = cleaner && actions.active()
    ? releaseTrafficSince(watchStartedAt) ?? watchStartedAt
    : null;
  const memoryActions = ports.memoryActions ?? productionMemoryPressureActions(actions);
  /* Memory is read on the same 30 s beat. Its own failure is logged and never
     delays the disk observation. */
  const observeMemory = async () => {
    try {
      const reading = readMemoryReading();
      if (reading) await reconcileMemoryPressure(observeMemoryPressureReport(reading, new Date(now()).toISOString()), memoryActions);
    } catch (error) {
      console.error("[memory pressure] observation failed", error instanceof Error ? error.message : String(error));
    }
  };
  const observe = ports.observe ?? (async () => {
    await observeMemory();
    if (cleaner) {
      if (!actions.active()) trafficSince = null;
      else if (process.env.PORT?.trim()) trafficSince = releaseTrafficSince(now()) ?? trafficSince ?? now();
      else trafficSince ??= now();
    }
    let pressure = null;
    try {
      pressure = await (ports.readPressure ?? readDiskPressure)();
      if (cleaner && actions.active()) {
        if (process.env.PORT?.trim()) trafficSince = releaseTrafficSince(now()) ?? trafficSince ?? now();
        else trafficSince ??= now();
      }
      else if (cleaner) trafficSince = null;
      await reconcileDiskPressure(pressure, { ...actions, cleaner });
    } finally {
      // Startup deliberately supplies no launcher until the guarded tools
      // ship. The pressure observer alone creates no cleaner run or receipt.
      if (cleaner && trafficSince !== null) {
        try {
          await cleaner.reconcile();
          if (pressure) await reconcileDiskPressure(pressure, { ...actions, cleaner });
        }
        finally { await cleaner.launchCleanerIfDue(actions.project, () => {
          if (!actions.active()) return now();
          return trafficSince ?? now();
        }, pressure); }
      }
    }
  });
  const schedule = ports.schedule ?? setTimeout;
  const arm = (delay: number) => {
    const timer = schedule(() => {
      void observe().catch(error => console.error("[disk pressure] observation failed", error instanceof Error ? error.message : String(error)))
        .finally(() => { if (host.__delegatusDiskPressureTimer === timer) arm(30_000); });
    }, delay);
    timer.unref?.(); host.__delegatusDiskPressureTimer = timer;
  };
  arm(0);
}

export function stopDiskPressureWatch(): void {
  if (host.__delegatusDiskPressureTimer) clearTimeout(host.__delegatusDiskPressureTimer);
  host.__delegatusDiskPressureTimer = undefined;
}
