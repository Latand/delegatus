import fs from "node:fs";

export const STATE_DISK_FULL_FLOOR_BYTES = 64 * 1024 * 1024;
export type StateWriteHealth = { state: "ok" | "disk-full"; freeBytes: number | null; since: string | null };
const shared = globalThis as typeof globalThis & { __llvStateWriteHealth?: { since: string | null; lastCommit: string | null; clearedSince: string | null } };
const health = shared.__llvStateWriteHealth ??= { since: null, lastCommit: null, clearedSince: null };
let freeBytesProbe: ((directory: string) => number | null) | null = null;

export class StateDiskFullError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(`disk full, state writes failing (${detail})`, { cause });
    this.name = "StateDiskFullError";
  }
}
export function isDiskFullError(error: unknown): boolean {
  if (error instanceof StateDiskFullError) return true;
  const value = error as { code?: unknown; message?: unknown } | null;
  return value?.code === "SQLITE_FULL" || value?.code === "ENOSPC"
    || /database or disk is full|ENOSPC|no space left on device|^disk full, state writes failing \(/i.test(String(value?.message ?? error));
}
export function noteStateDiskFull(detail: string): void {
  void detail;
  health.since ??= new Date().toISOString();
}
export function noteStateCommit(): void {
  if (health.since && (!health.clearedSince || health.since > health.clearedSince)) health.clearedSince = health.since;
  health.since = null;
  health.lastCommit = new Date().toISOString();
}
export function stateFreeBytes(directory: string): number | null {
  if (freeBytesProbe) return freeBytesProbe(directory);
  try { const info = fs.statfsSync(directory); return info.bavail * info.bsize; }
  catch { return null; }
}
export function stateWriteHealth(directory: string, observed?: StateWriteHealth): StateWriteHealth {
  // A worker can observe a failure the serving process has not seen. Carry it
  // until a later successful commit proves recovery, without persisting it.
  if (observed?.state === "disk-full" && observed.since
    && (!health.clearedSince || observed.since > health.clearedSince)
    && (!health.lastCommit || Date.parse(observed.since) >= Date.parse(health.lastCommit))) {
    if (!health.since || Date.parse(observed.since) < Date.parse(health.since)) health.since = observed.since;
  }
  const freeBytes = stateFreeBytes(directory);
  return { state: health.since !== null || (freeBytes !== null && freeBytes < STATE_DISK_FULL_FLOOR_BYTES) ? "disk-full" : "ok",
    freeBytes, since: health.since };
}
export function setStateFreeBytesProbeForTests(probe: typeof freeBytesProbe): void { freeBytesProbe = probe; }
