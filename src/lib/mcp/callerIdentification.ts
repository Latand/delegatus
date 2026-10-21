import { redactBounded } from "@/lib/monitor/redact";
import { StateStartupMutationRefused } from "@/lib/stateOwnership";
import { RegistryBackendIdentityError } from "@/lib/agent/registryBackendIdentity";
import { StateLockDeferredError, stateDatabaseBusy, stateLockAttempt, stateLockDeferral, waitForStateLock } from "@/lib/state/lockWait";

/** Never include a request, capability, registry row or raw stack in logs. */
export function logCallerIdentificationError(error: unknown, capability?: string, outcome: "failed" | "waiting-for-registry" = "failed"): void {
  const clean = (value: string) => redactBounded(capability ? value.replaceAll(capability, "[redacted]") : value, 700);
  // A diagnostic has a fixed shape even while unrelated tool claims are live.
  console.error(`[mcp caller-identification] ${JSON.stringify({
    pid: process.pid, phase: "caller-identification", operation: "registry-read", outcome,
    error: clean(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
  })}`);
}

/** The serving owner performs migrations. Readers wait without taking that
 * authority, under the earlier of the caller's deadline and five seconds.
 * Each attempt resolves the capability again; no identity is cached. */
export async function identifyCallerWhenReady(resolve: () => string | null, capability: string | undefined,
  deadlineAt: number, signal: AbortSignal): Promise<string | null> {
  let reportedWaiting = false;
  try {
    signal.throwIfAborted();
    const waitMs = Math.min(5_000, deadlineAt - Date.now());
    if (waitMs <= 0) throw new Error("caller identification deadline expired");
    return await waitForStateLock("mcp.caller-identification", () => stateLockAttempt("mcp.caller-identification", () => {
      try { return resolve(); }
      catch (error) {
        const awaitingOwner = error instanceof StateStartupMutationRefused
          || error instanceof RegistryBackendIdentityError && error.awaitingPublication;
        if (!awaitingOwner && !stateDatabaseBusy(error) && !stateLockDeferral(error)) throw error;
        if (!reportedWaiting) {
          reportedWaiting = true;
          logCallerIdentificationError(error, capability, "waiting-for-registry");
        }
        throw new StateLockDeferredError("mcp.caller-identification", awaitingOwner ? "lease" : "sqlite");
      }
    }), { waitMs, signal });
  } catch (error) {
    logCallerIdentificationError(error, capability);
    throw error;
  }
}
