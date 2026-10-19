/** Decoded data only: connections, decoders and mutation sessions stay local to
 * each compiled module. Eviction clears the slot even if a collection holds it.
 * The budgets count UTF-16 input bytes; decoded graphs can occupy more heap. */
export type ReadCacheSlot<T> = { value: T | null; bytes: number };
type CacheHost = typeof globalThis & {
  __llvCollectionReadCachesV1?: Map<string, ReadCacheSlot<unknown>>;
  __llvArchiveReadCacheV1?: { key: string; slot: ReadCacheSlot<unknown> };
  __llvReadCacheEvictionAt?: number;
};
const host = globalThis as CacheHost;
const slots = host.__llvCollectionReadCachesV1 ??= new Map();
const MAX_SLOTS = 8;
const MAX_BYTES = 256 * 1024 * 1024;
const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;

/** One archive generation across compiled modules, separate from the hot LRU. */
export function collectionReadCache<T>(key: string, archive = false): ReadCacheSlot<T> {
  if (archive) {
    const held = host.__llvArchiveReadCacheV1;
    if (held?.key === key) return held.slot as ReadCacheSlot<T>;
    if (held) { held.slot.value = null; held.slot.bytes = 0; }
    const slot = { value: null, bytes: 0 };
    host.__llvArchiveReadCacheV1 = { key, slot };
    return slot;
  }
  const slot = slots.get(key) ?? { value: null, bytes: 0 };
  slots.delete(key);
  slots.set(key, slot);
  while (slots.size > MAX_SLOTS) evict(slots.keys().next().value!);
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
    return;
  }
  let total = 0;
  for (const held of slots.values()) total += held.bytes;
  for (const [key, held] of slots) {
    if (total <= MAX_BYTES) break;
    total -= held.bytes;
    evict(key, MAX_BYTES);
  }
}
