import type { CleanerSlice } from "@/lib/cleaner/diskJournal";

type SweepKind = "temp" | "attempt-temp" | "worktrees" | "releases";
type ReleaseSweep = (id: string) => Promise<CleanerSlice>;
const host = globalThis as typeof globalThis & { __delegatusPressureSweeps?: Map<SweepKind, () => void>; __delegatusCleanerReleases?: ReleaseSweep };
const hooks = () => host.__delegatusPressureSweeps ??= new Map();

/** Timers own admission and overlap. Pressure only advances an idle timer. */
export function registerDiskPressureSweep(kind: SweepKind, request: () => void) {
  hooks().set(kind, request);
  return () => { if (hooks().get(kind) === request) hooks().delete(kind); };
}

export function requestDiskPressureSweeps(): void {
  for (const request of hooks().values()) request();
}

export function registerCleanerReleaseSweep(run: ReleaseSweep) {
  host.__delegatusCleanerReleases = run;
  return () => { if (host.__delegatusCleanerReleases === run) delete host.__delegatusCleanerReleases; };
}

export async function sweepCleanerReleases(id: string): Promise<CleanerSlice> {
  if (!host.__delegatusCleanerReleases) return { kept: [], errors: 0 };
  return host.__delegatusCleanerReleases(id);
}
