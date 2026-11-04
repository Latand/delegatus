import { readDiskPressure } from "./diskPressure";
import { productionDiskPressureActions, reconcileDiskPressure } from "./diskPressureActions";

const host = globalThis as typeof globalThis & { __delegatusDiskPressureTimer?: ReturnType<typeof setTimeout> };

/** The release-owning startup calls this even when automatic cleanup is off.
 * Pressure remains observable without an open browser or an enabled seat. */
export function startDiskPressureWatch(ports: {
  observe?: () => Promise<unknown>;
  schedule?: typeof setTimeout;
} = {}): void {
  if (host.__delegatusDiskPressureTimer || (!ports.observe && process.env.LLV_STATE_OWNER !== "viewer")) return;
  const observe = ports.observe ?? (async () => {
    const pressure = await readDiskPressure();
    await reconcileDiskPressure(pressure, productionDiskPressureActions());
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
