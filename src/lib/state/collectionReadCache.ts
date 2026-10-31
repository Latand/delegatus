import { cacheCounter } from "../cacheTelemetry";

/** Decoded data only: connections, decoders and mutation sessions stay local to
 * each compiled module. Eviction clears the slot even if a collection holds it.
 * The budgets count UTF-16 input bytes; decoded graphs can occupy more heap. */
export type ReadCacheSlot<T> = { value: T | null; bytes: number };
type CacheHost = typeof globalThis & {
  __llvCollectionReadCachesV1?: Map<string, ReadCacheSlot<unknown>>;
  __llvArchiveReadCacheV1?: { key: string; slot: ReadCacheSlot<unknown> };
  __llvReadCacheEvictionAt?: number;
  __llvReadCacheTelemetry?: { hot: ReturnType<typeof cacheCounter>; archive: ReturnType<typeof cacheCounter> };
};
const host = globalThis as CacheHost;
const slots = host.__llvCollectionReadCachesV1 ??= new Map();
const telemetry = host.__llvReadCacheTelemetry ??= {
  hot: cacheCounter(slots, "hot", "state/collectionReadCache", "source-utf16"),
  archive: cacheCounter(slots, "archive", "state/collectionReadCache", "source-utf16"),
};
function updateTelemetry() {
  let count = 0, bytes = 0;
  for (const slot of slots.values()) if (slot.value !== null) { count++; bytes += slot.bytes; }
  telemetry.hot.set(count, bytes);
  const archive = host.__llvArchiveReadCacheV1?.slot;
  telemetry.archive.set(archive?.value != null ? 1 : 0, archive?.bytes ?? 0);
}
const MAX_SLOTS = 8;
const MAX_BYTES = 256 * 1024 * 1024;
// The retained archive can exceed 512 MiB in UTF-16 input bytes. Evicting it
// after every read made each seat decode it again and multiplied live heaps.
// Keep one generation resident with headroom, still outside the hot-row LRU.
const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;

/** One archive generation across compiled modules, separate from the hot LRU. */
export function collectionReadCache<T>(key: string, archive = false): ReadCacheSlot<T> {
  if (archive) {
    const held = host.__llvArchiveReadCacheV1;
    if (held?.key === key) return held.slot as ReadCacheSlot<T>;
    if (held) { held.slot.value = null; held.slot.bytes = 0; }
    const slot = { value: null, bytes: 0 };
    host.__llvArchiveReadCacheV1 = { key, slot };
    updateTelemetry();
    return slot;
  }
  const slot = slots.get(key) ?? { value: null, bytes: 0 };
  slots.delete(key);
  slots.set(key, slot);
  while (slots.size > MAX_SLOTS) evict(slots.keys().next().value!);
  updateTelemetry();
  return slot as ReadCacheSlot<T>;
}

function evictionLine(key: string, bytes: number, budgetBytes: number): void {
  const now = Date.now();
  if (host.__llvReadCacheEvictionAt !== undefined && now - host.__llvReadCacheEvictionAt < 60_000) return;
  host.__llvReadCacheEvictionAt = now;
  // Cache keys also carry database paths and authority; log only the collection.
  const parts = JSON.parse(key) as unknown[];
  const collection = parts[2] === "controller-v1" ? parts[1] : parts[2];
  console.warn("[state read-cache eviction]", JSON.stringify({ collection, bytes, budgetBytes }));
}

function evict(key: string, budgetBytes?: number): void {
  const slot = slots.get(key)!;
  if (budgetBytes !== undefined) evictionLine(key, slot.bytes, budgetBytes);
  slot.value = null;
  slot.bytes = 0;
  slots.delete(key);
}

export function rememberCollectionReadCache<T>(slot: ReadCacheSlot<T>, value: T, bytes: number): void {
  slot.value = value;
  slot.bytes = bytes;
  const archive = host.__llvArchiveReadCacheV1;
  if (archive?.slot === slot) {
    if (bytes > ARCHIVE_MAX_BYTES) {
      evictionLine(archive.key, bytes, ARCHIVE_MAX_BYTES);
      slot.value = null;
      slot.bytes = 0;
    }
    updateTelemetry();
    return;
  }
  let total = 0;
  for (const held of slots.values()) total += held.bytes;
  for (const [key, held] of slots) {
    if (total <= MAX_BYTES) break;
    total -= held.bytes;
    evict(key, MAX_BYTES);
  }
  updateTelemetry();
}
