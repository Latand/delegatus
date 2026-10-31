type SweepKind = "temp" | "attempt-temp" | "worktrees" | "releases";
const host = globalThis as typeof globalThis & { __delegatusPressureSweeps?: Map<SweepKind, () => void> };
const hooks = () => host.__delegatusPressureSweeps ??= new Map();

/** Timers own admission and overlap. Pressure only advances an idle timer. */
export function registerDiskPressureSweep(kind: SweepKind, request: () => void) {
  hooks().set(kind, request);
  return () => { if (hooks().get(kind) === request) hooks().delete(kind); };
}

export function requestDiskPressureSweeps(): void {
  for (const request of hooks().values()) request();
}
