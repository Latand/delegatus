import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { sweepMonotonicNow } from "@/lib/runtime/attemptTempDeadline";

type Deferral = "busy" | "memory";

export class SweepWalkDeferred extends Error {
  constructor(readonly reason: Deferral) {
    super(`cleanup walk deferred (${reason})`);
  }
}

export const WORKTREE_SWEEP_RSS_HIGH_WATER_BYTES = 224 * 1024 ** 2;

export function sweepMemoryPressured(read = (file: string) => fs.readFileSync(file, "utf8")): boolean {
  if (process.platform !== "linux") return false;
  try {
    const meminfo = read("/proc/meminfo");
    const total = Number(/^MemTotal:\s+(\d+) kB$/m.exec(meminfo)?.[1]);
    const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1]);
    if (available < Math.min(total / 4, 8 * 1024 ** 2)) return true;
  } catch { /* PSI may still be available. */ }
  try {
    const pressure = read("/proc/pressure/memory");
    return Number(/^some avg10=([\d.]+)/m.exec(pressure)?.[1]) >= 10
      || Number(/^full avg10=([\d.]+)/m.exec(pressure)?.[1]) >= 5;
  } catch { return false; }
}

/** Within one admitted job, leave at the next safe checkpoint after pressure
 * starts. An already dispatched mutation keeps its own cleanup deadline. */
export function sweepPressureCheckpoint(checkRss = false, read?: (file: string) => string) {
  let pressured = false;
  return (_now: number) => {
    if (!pressured) {
      pressured = sweepMemoryPressured(read) || checkRss && process.memoryUsage.rss() >= WORKTREE_SWEEP_RSS_HIGH_WATER_BYTES;
    }
    return pressured;
  };
}

/** Every leased cleaner uses the same state-root lease, including during
 * Viewer succession. Keep observations and queue waits outside the walk. */
export async function withSweepWalk<T>(deadline: number, walk: () => Promise<T>): Promise<T> {
  if (sweepMemoryPressured()) throw new SweepWalkDeferred("memory");
  const { tryLockFenceExclusive } = await import("../../runtime-host/fenceLock");
  const filename = statePath("cleanup-walk.lock");
  await fs.promises.mkdir(statePath(), { recursive: true, mode: 0o700 });
  const handle = await fs.promises.open(filename, "a", 0o600);
  const admissibleUntil = Math.min(deadline - 1000, sweepMonotonicNow() + 1000);
  try {
    while (sweepMonotonicNow() < admissibleUntil) {
      const lease = tryLockFenceExclusive({ fd: handle.fd, filename });
      if (lease) {
        try {
          if (sweepMemoryPressured()) throw new SweepWalkDeferred("memory");
          return await walk();
        } finally { lease.release(); }
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(100, admissibleUntil - sweepMonotonicNow()))));
    }
    throw new SweepWalkDeferred("busy");
  } finally { await handle.close(); }
}
