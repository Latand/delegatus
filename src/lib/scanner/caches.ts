import { MeasuredCache } from "../cacheTelemetry";

/**
 * Module-level caches must survive Next.js dev hot-reload, so they hang off
 * `globalThis`. Every scanner module gets its named Map through this helper.
 *
 * Invalidation conventions (same as the Python prototype):
 *  - size-keyed: value stored as [size, payload]; recompute when size differs;
 *  - mtime-keyed: for small JSON sidecar files;
 *  - append-only: needle scans remember how many bytes of each file were
 *    already searched and only scan the appended suffix.
 */
const store = globalThis as unknown as {
  __llvCaches?: Record<string, Map<string, unknown>>;
};

/** The first owner may supply an incremental estimator for its named cache. */
export function globalCache<V>(name: string, measure?: (value: V, key: string) => number): Map<string, V> {
  store.__llvCaches ??= {};
  store.__llvCaches[name] ??= new MeasuredCache(name, "scanner/caches", measure);
  return store.__llvCaches[name] as Map<string, V>;
}
