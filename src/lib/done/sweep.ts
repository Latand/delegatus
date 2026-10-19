import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { projectDoneItems, type DoneWorld } from "./project";

/*
 * The «Готово» clock (docs/design/done-section.md §3): the release that owns
 * traffic projects every minute, so an outcome lands in the store while its
 * source still holds it, whether or not a tab is open. The report log, the
 * deploy ledger and the limits history roll over on their own; the store
 * keeps what the sweep took from them until the operator accepts it.
 */

export const DONE_SWEEP_INTERVAL_MS = 60_000;
const FIRST_SWEEP_DELAY_MS = 15_000;

async function releaseOwnsTraffic(): Promise<boolean> {
  try {
    const { viewerReleaseOwnsTraffic } = await import("@/lib/viewerInstrumentation");
    return viewerReleaseOwnsTraffic();
  } catch {
    return true;
  }
}

async function productionWorld(): Promise<DoneWorld> {
  const { productionDoneWorld } = await import("./world");
  return productionDoneWorld({ recover: true });
}

/** One projection, unless another release owns traffic. Answers whether it ran. */
export async function runDoneSweepOnce(ports: {
  world?: () => DoneWorld | Promise<DoneWorld>;
  ownsTraffic?: () => Promise<boolean>;
} = {}): Promise<boolean> {
  return withViewerOperation("done.sweep", async () => {
    if (!(await (ports.ownsTraffic ?? releaseOwnsTraffic)())) return false;
    // A browser polling just ahead of every tick must not starve background
    // recovery, which alone may consult retained PR and git images.
    await projectDoneItems(await (ports.world ?? productionWorld)(), { force: true });
    return true;
  });
}

const host = globalThis as typeof globalThis & { __llvDoneSweepTimer?: ReturnType<typeof setTimeout> };

export function startDoneSweep(ports: {
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  sweep?: () => Promise<unknown>;
} = {}): void {
  if (host.__llvDoneSweepTimer) return;
  const schedule = ports.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const sweep = ports.sweep ?? (() => runDoneSweepOnce());
  const arm = (delayMs: number) => {
    const timer = schedule(() => {
      void sweep()
        .catch((error) => console.error("[done] sweep failed", error instanceof Error ? error.name : "unknown"))
        .finally(() => {
          if (host.__llvDoneSweepTimer === timer) arm(DONE_SWEEP_INTERVAL_MS);
        });
    }, delayMs);
    timer.unref?.();
    host.__llvDoneSweepTimer = timer;
  };
  arm(FIRST_SWEEP_DELAY_MS);
}

/** Test seam: the timer is process-global. */
export function stopDoneSweep(): void {
  if (host.__llvDoneSweepTimer) clearTimeout(host.__llvDoneSweepTimer);
  host.__llvDoneSweepTimer = undefined;
}
