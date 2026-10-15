/** Decoded data only: connections, decoders and mutation sessions stay local to
 * each compiled module. Eviction clears the slot even if a collection holds it.
 * The budget counts UTF-16 input bytes; decoded graphs can occupy more heap. */
export type ReadCacheSlot<T> = { value: T | null; bytes: number };
type CacheHost = typeof globalThis & {
  __llvCollectionReadCachesV1?: Map<string, ReadCacheSlot<unknown>>;
};
const host = globalThis as CacheHost;
const slots = host.__llvCollectionReadCachesV1 ??= new Map();
const MAX_SLOTS = 8;
const MAX_BYTES = 256 * 1024 * 1024;

export function collectionReadCache<T>(key: string): ReadCacheSlot<T> {
  const slot = slots.get(key) ?? { value: null, bytes: 0 };
  slots.delete(key);
  slots.set(key, slot);
  while (slots.size > MAX_SLOTS) evict(slots.keys().next().value!);
  return slot as ReadCacheSlot<T>;
}

function evict(key: string): void {
  const slot = slots.get(key)!;
  slot.value = null;
  slot.bytes = 0;
  slots.delete(key);
}

export function rememberCollectionReadCache<T>(slot: ReadCacheSlot<T>, value: T, bytes: number): void {
  slot.value = value;
  slot.bytes = bytes;
  let total = 0;
  for (const held of slots.values()) total += held.bytes;
  for (const [key, held] of slots) {
    if (total <= MAX_BYTES) break;
    total -= held.bytes;
    evict(key);
  }
}
