import { performanceSpans } from "./performanceSpans";

/** Cache owners publish scalars when they mutate. Sampling never calls an
 * owner, enumerates a cache, serializes a value or retains a cached object. */
export type CacheSize = { name: string; owner: string; count: number; bytes: number; unmeasured: number; basis: string };
type Counter = { count: number; bytes: number; unmeasured: number; retired: boolean };
type Registry = { rows: Map<string, CacheSize>; omitted: number; finalizer: FinalizationRegistry<{ row: CacheSize; counter: Counter }> };
const host = globalThis as typeof globalThis & { __delegatusCacheTelemetry?: Registry };
const registry = host.__delegatusCacheTelemetry ??= {
  rows: new Map<string, CacheSize>(), omitted: 0,
  finalizer: new FinalizationRegistry<{ row: CacheSize; counter: Counter }>(({ row, counter }) => {
    row.count -= counter.count; row.bytes -= counter.bytes; row.unmeasured -= counter.unmeasured;
    counter.count = counter.bytes = counter.unmeasured = 0; counter.retired = true;
  }),
};
export const CACHE_TELEMETRY_MAX_OWNERS = 256;

/** Names and owners are code constants, never paths or request identities.
 * Multiple instances aggregate under one name; their death releases scalars.
 * Explicit clear/eviction is reflected immediately without waiting for GC. */
export function cacheCounter(target: object, name: string, owner: string, basis: string) {
  const key = `${owner}:${name}`;
  let row = registry.rows.get(key);
  if (!row && registry.rows.size < CACHE_TELEMETRY_MAX_OWNERS) {
    row = { name: name.slice(0, 96), owner: owner.slice(0, 96), basis: basis.slice(0, 48), count: 0, bytes: 0, unmeasured: 0 }; registry.rows.set(key, row);
  }
  if (!row) registry.omitted++;
  const counter = { count: 0, bytes: 0, unmeasured: 0, retired: false };
  if (row) registry.finalizer.register(target, { row, counter });
  return {
    set(count: number, bytes: number, unmeasured = 0) {
      if (counter.retired) return;
      if (row) { row.count += count - counter.count; row.bytes += bytes - counter.bytes; row.unmeasured += unmeasured - counter.unmeasured; }
      counter.count = count; counter.bytes = bytes; counter.unmeasured = unmeasured;
    },
    add(count: number, bytes: number, unmeasured = 0) {
      this.set(counter.count + count, counter.bytes + bytes, counter.unmeasured + unmeasured);
    },
  };
}

export function cacheSizes() {
  return { caches: Array.from(registry.rows.values(), row => ({ ...row })), omitted: registry.omitted };
}

/** Mutation-time payload estimate, excluding VM/allocator overhead. Strings
 * use UTF-16 bytes, buffers their view length. Shared references within an entry
 * count once. Getters and native handles are never invoked. */
export function cachePayloadBytes(value: unknown, seen = new Set<object>(), depth = 0): number {
  if (depth > 64 || seen.size > 100_000) throw new Error("cache size estimate budget exhausted");
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "boolean") return 4;
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return value.byteLength;
  if (value instanceof Map) {
    let bytes = 0;
    for (const [key, item] of value) bytes += cachePayloadBytes(key, seen, depth + 1) + cachePayloadBytes(item, seen, depth + 1);
    return bytes;
  }
  if (value instanceof Set) {
    let bytes = 0;
    for (const item of value) bytes += cachePayloadBytes(item, seen, depth + 1);
    return bytes;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return 0;
  let bytes = 0;
  for (const key of Object.keys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    bytes += key.length * 2 + ("value" in property ? cachePayloadBytes(property.value, seen, depth + 1) : 0);
  }
  return bytes;
}

type Charge = { bytes: number; unmeasured: number };
function measureCharge(work: () => number): Charge {
  try {
    const bytes = performanceSpans.sync("cache.accounting", work);
    if (Number.isFinite(bytes) && bytes >= 0) return { bytes, unmeasured: 0 };
  } catch { /* Accounting cannot refuse a cache write. */ }
  return { bytes: 0, unmeasured: 1 };
}

/** Keeps Map semantics and existing owner eviction policies. Re-setting an
 * entry refreshes its charge, including an entry changed in place. */
export class MeasuredCache<K, V> extends Map<K, V> {
  private charges = new Map<K, Charge>();
  private counter: ReturnType<typeof cacheCounter>;
  constructor(name: string, owner: string,
    private measure: (value: V, key: K) => number = (value, key) => cachePayloadBytes([key, value]),
    basis = "payload-estimate") {
    super();
    this.counter = cacheCounter(this, name, owner, basis);
  }
  override set(key: K, value: V): this {
    const { bytes, unmeasured } = measureCharge(() => this.measure(value, key));
    const previous = this.charges.get(key);
    this.counter.add(this.has(key) ? 0 : 1, bytes - (previous?.bytes ?? 0), unmeasured - (previous?.unmeasured ?? 0));
    this.charges.set(key, { bytes, unmeasured });
    return super.set(key, value);
  }
  override delete(key: K): boolean {
    if (!super.delete(key)) return false;
    const previous = this.charges.get(key)!;
    this.counter.add(-1, -previous.bytes, -previous.unmeasured);
    this.charges.delete(key);
    return true;
  }
  override clear(): void {
    super.clear(); this.charges.clear(); this.counter.set(0, 0);
  }
}

/** Weak payloads follow their existing key's lifetime. The registry keeps only
 * charges; neither its finalizers nor a diagnostic read strengthen the key. */
export class MeasuredWeakCache<K extends object, V> {
  private entries = new WeakMap<K, { value: V; charge: Charge }>();
  private counter: ReturnType<typeof cacheCounter>;
  private finalizer: FinalizationRegistry<Charge>;
  constructor(name: string, owner: string, private measure: (value: V) => number) {
    const counter = this.counter = cacheCounter(this, name, owner, "buffer-bytes");
    this.finalizer = new FinalizationRegistry(charge => counter.add(-1, -charge.bytes, -charge.unmeasured));
  }
  get(key: K) { return this.entries.get(key)?.value; }
  set(key: K, value: V): void {
    this.delete(key);
    const charge = measureCharge(() => this.measure(value));
    const entry = { value, charge };
    this.entries.set(key, entry);
    this.counter.add(1, charge.bytes, charge.unmeasured);
    // The held charge must contain no value (a value may point back to its key).
    this.finalizer.register(key, charge, entry);
  }
  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.finalizer.unregister(entry);
    this.counter.add(-1, -entry.charge.bytes, -entry.charge.unmeasured);
    return this.entries.delete(key);
  }
}
