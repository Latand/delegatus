/** Next loads instrumentation and route bundles as separate module graphs in
 * one process. Link cursors, freshness and queues must have one owner there. */
const host = globalThis as typeof globalThis & { __llvLinkRuntimeState?: Map<string, unknown> };

export function sharedLinkState<T>(key: string, create: () => T): T {
  const states = host.__llvLinkRuntimeState ??= new Map();
  if (!states.has(key)) states.set(key, create());
  return states.get(key) as T;
}
