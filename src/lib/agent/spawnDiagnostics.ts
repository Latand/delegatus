import type { AgentRegistry } from "@/lib/agent/registry";
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

/** A background controller has no request scope; its durable receipts restore it.
    An unattributed controller failure may concern any of its owner receipts. */
export function spawnDiagnosticErrorForRegistry(registry: Pick<AgentRegistry, "readOnlySnapshot"> | null, ...args: unknown[]): void {
  let ownerAttempt: string | undefined;
  try {
    if (!registry) throw new Error("diagnostic attribution unavailable");
    const receipts = Object.values(registry.readOnlySnapshot().receipts);
    const fields = args.filter(value => value && typeof value === "object") as object[];
    const field = (key: string) => fields.map(value => Object.getOwnPropertyDescriptor(value, key)?.value)
      .find(value => typeof value === "string") as string | undefined;
    const operationId = field("operationId"), conversationId = field("conversationId");
    const attributed = operationId?.startsWith("spawn_message_")
      ? receipts.find(receipt => receipt.launchId === operationId.slice("spawn_message_".length))
      : conversationId ? receipts.find(receipt => receipt.conversationId === conversationId) : undefined;
    ownerAttempt = (attributed ? [attributed] : receipts)
      .find(receipt => receipt.clientAttemptId?.startsWith("relay-owner-"))?.clientAttemptId ?? undefined;
  } catch {
    // A failed receipt read cannot authorize raw diagnostic emission.
    ownerAttempt = "relay-owner-unattributed-diagnostic";
  }
  spawnDiagnosticErrorFor(ownerAttempt, ...args);
}
