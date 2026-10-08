/**
 * Freezes `value` and every object reachable from it through its own data
 * properties. A shared read view leaves its cache frozen, so the reader that
 * holds it cannot change what the next reader gets: module code is strict, and
 * an assignment, push or delete on it throws where it would otherwise have
 * written into every later read.
 *
 * An object already frozen is taken as frozen all the way down and is not walked
 * again, which is what lets a view rebuilt after one change freeze only the
 * records that change produced.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return value;
}
