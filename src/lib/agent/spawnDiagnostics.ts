import { AsyncLocalStorage } from "node:async_hooks";
import { scrubOwnerOutput } from "@/lib/externalRelay/ownerOutput";

const ownerDiagnostics = new AsyncLocalStorage<boolean>();

/** A request id selects stricter diagnostics only; it grants no authority. */
export function withSpawnDiagnostics<T>(clientAttemptId: unknown, work: () => T): T {
  return ownerDiagnostics.run(ownerDiagnostics.getStore() === true
    || typeof clientAttemptId === "string" && clientAttemptId.startsWith("relay-owner-"), work);
}

export function bindSpawnDiagnostics<T>(work: () => T): () => T {
  const owner = ownerDiagnostics.getStore() === true;
  return () => ownerDiagnostics.run(owner, work);
}

/** Serialize before scrubbing so console cannot inspect a raw object or stack. */
export function spawnDiagnosticError(...args: unknown[]): void {
  if (!ownerDiagnostics.getStore()) { console.error(...args); return; }
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(args, (_key, value) => {
      if (typeof value === "string") return scrubOwnerOutput(value);
      if (value && typeof value === "object") {
        if (seen.has(value)) return "[circular]";
        seen.add(value);
        if (value instanceof Error) return Object.fromEntries(
          Object.getOwnPropertyNames(value).map(key => [key, (value as unknown as Record<string, unknown>)[key]]),
        );
      }
      return value;
    });
    console.error(scrubOwnerOutput(serialized));
  } catch {
    // Resolver, getters and serialization failures must never expose the input.
    console.error("Owner relay diagnostic unavailable; sensitive details withheld");
  }
}

/** Recovery has no originating request context; its receipt restores the boundary. */
export function spawnDiagnosticErrorFor(clientAttemptId: unknown, ...args: unknown[]): void {
  withSpawnDiagnostics(clientAttemptId, () => spawnDiagnosticError(...args));
}
