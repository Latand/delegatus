import { procBackend } from "@/lib/proc";

/** The exhaustion reported in #1211 occurred around 1 GiB available RAM.
    Keep another GiB of headroom at launch; agent ceilings govern later work. */
const LAUNCH_MEMORY_FLOOR = 2 * 1024 ** 3;

/** Use reclaim-aware RAM, independent of lane count, swap and memory-limit
    mode. An unavailable measurement supplies no evidence for a refusal. */
export function assertSpawnMemoryAvailable(): void {
  const memory = procBackend.systemMemory();
  if (!memory || !Number.isFinite(memory.ramAvailable) || memory.ramAvailable < 0
    || memory.ramAvailable >= LAUNCH_MEMORY_FLOOR) return;
  throw new Error(`Agent launch refused: ${Math.floor(memory.ramAvailable / 1024 ** 2)} MiB RAM available; at least 2048 MiB required. Retry after memory is freed.`);
}
