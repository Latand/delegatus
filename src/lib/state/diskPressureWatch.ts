import fs from "node:fs";
import type { CleanerController } from "@/lib/cleaner/run";
import { statePath } from "@/lib/configDir";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { readDiskPressure } from "./diskPressure";
import { productionDiskPressureActions, productionMemoryPressureActions, reconcileDiskPressure, type DiskPressureActions } from "./diskPressureActions";
import { observeMemoryPressureReport, reconcileMemoryPressure, type MemoryPressureActions, type MemoryReading } from "./memoryPressure";

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
  automatic?: (pressure: Awaited<ReturnType<typeof readDiskPressure>>) => Promise<void>;
  now?: () => number;
  memoryActions?: MemoryPressureActions;
  readMemory?: () => Promise<MemoryReading | null>;
} = {}): void {
  if (host.__delegatusDiskPressureTimer || (!ports.observe && process.env.LLV_STATE_OWNER !== "viewer")) return;
  const cleaner = ports.cleaner;
  const actions = ports.actions ?? productionDiskPressureActions();
  const now = ports.now ?? Date.now;
  let running = false;
  const automatic = ports.automatic ?? (ports.actions || process.env.NODE_ENV === "test" ? undefined : async (pressure: Awaited<ReturnType<typeof readDiskPressure>>) => {
    const [{ reconcileAutomaticDiskCleaner }, { diskCleanerReport }, { runDiskCleanerOffThread }, { sweepCleanerReleases }] = await Promise.all([
      import("@/lib/cleaner/diskController"), import("@/lib/cleaner/diskReport"), import("@/lib/pipelines/worktreeSweepWorker"), import("./diskPressureSweeps"),
    ]);
    await reconcileAutomaticDiskCleaner(pressure, {
      active: () => !!host.__delegatusDiskPressureTimer && actions.active(), project: actions.project,
      sweep: runDiskCleanerOffThread, releases: sweepCleanerReleases,
      card: async pass => {
        const latest = await readDiskPressure();
        return actions.card(pass.project, {
          ref: "seat-disk-pressure", kind: "disk-pressure", instance: pass.episode ?? pass.id,
          cleanupReport: true,
          state: pass.episode && pass.episode === latest.episode ? "open" : "resolved", detail: diskCleanerReport(pass),
        }, new Date(pass.finished!.at).toISOString());
      },
    });
  });
  const requestAutomaticPass = (pressure: Awaited<ReturnType<typeof readDiskPressure>>) => {
    if (!automatic || !actions.active() || running) return;
    running = true;
    void automatic(pressure).catch(error => console.error("[disk cleaner] pass failed", error instanceof Error ? error.message : String(error)))
      .finally(() => { running = false; });
  };
  const watchStartedAt = now();
  let trafficSince = cleaner && actions.active()
    ? releaseTrafficSince(watchStartedAt) ?? watchStartedAt
    : null;
  const readMemory = ports.readMemory ?? (ports.actions || process.env.NODE_ENV === "test" ? undefined : async () =>
    (await import("@/lib/pipelines/worktreeSweepWorker")).readMemoryReadingOffThread());
  const memoryActions = ports.memoryActions ?? productionMemoryPressureActions(actions);
  let readingMemory = false;
  /* Memory is read on the same 30 s beat, off this thread. Neither a slow read
     nor a failed one delays the disk observation, and one runs at a time. */
  const requestMemoryObservation = () => {
    if (!readMemory || readingMemory) return;
    readingMemory = true;
    void readMemory().then(async reading => {
      if (reading) await reconcileMemoryPressure(observeMemoryPressureReport(reading, new Date(now()).toISOString()), memoryActions);
    }).catch(error => console.error("[memory pressure] observation failed", error instanceof Error ? error.message : String(error)))
      .finally(() => { readingMemory = false; });
  };
  const observe = ports.observe ?? (async () => {
    requestMemoryObservation();
    if (cleaner) {
      if (!actions.active()) trafficSince = null;
      else if (process.env.PORT?.trim()) trafficSince = releaseTrafficSince(now()) ?? trafficSince ?? now();
      else trafficSince ??= now();
    }
    let pressure = null;
    try {
      pressure = await (ports.readPressure ?? readDiskPressure)();
      requestAutomaticPass(pressure);
      if (cleaner && actions.active()) {
        if (process.env.PORT?.trim()) trafficSince = releaseTrafficSince(now()) ?? trafficSince ?? now();
        else trafficSince ??= now();
      }
      else if (cleaner) trafficSince = null;
      await reconcileDiskPressure(pressure, { ...actions, cleaner });
    } finally {
      if (!pressure) requestAutomaticPass({ at: new Date(now()).toISOString(), episode: null, volumes: [],
        consumers: [], warningBytes: 0, criticalBytes: 0 });
      // An injected dry-run conversation controller remains independent of
      // the pressure watch's automatic server-owned pass.
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
