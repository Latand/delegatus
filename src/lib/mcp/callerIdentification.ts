import { redactBounded } from "@/lib/monitor/redact";
import { StateStartupMutationRefused } from "@/lib/stateOwnership";
import { RegistryBackendIdentityError } from "@/lib/agent/registryBackendIdentity";
import { StateLockDeferredError, stateDatabaseBusy, stateLockAttempt, stateLockDeferral, waitForStateLock } from "@/lib/state/lockWait";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

export function callerIdentificationFailureClass(error: unknown, deadlineAt: number, signal: AbortSignal): string {
  if (error instanceof FileTransactionBusyError || stateLockDeferral(error)) return "registry-busy";
  if (signal.aborted || deadlineAt <= Date.now()) return "deadline";
  return "registry-read-failed";
}

/** Never include a request, capability, registry row or raw stack in logs. */
export function logCallerIdentificationError(error: unknown, capability?: string, outcome: "failed" | "waiting-for-registry" = "failed",
  context: { check?: string; phase?: "tool-service" } = {}): void {
  const clean = (value: string) => redactBounded(capability ? value.replaceAll(capability, "[redacted]") : value, 700);
  // A diagnostic has a fixed shape even while unrelated tool claims are live.
  const phase = context.phase ?? "caller-identification";
  // Parser messages can echo private input tokens. Their class is enough.
  const detail = error instanceof SyntaxError ? "SyntaxError"
    : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[mcp ${phase}] ${JSON.stringify({
    pid: process.pid, phase, operation: context.phase ? "service-construction" : "registry-read", outcome,
    ...(context.check ? { check: context.check } : {}),
    error: clean(detail),
  })}`);
}

/** What the refusal needs to reach the caller before the caller's own timeout does. */
const CALLER_IDENTIFICATION_REPLY_RESERVE_MS = 250;

/** The serving owner performs migrations. Readers wait without taking that
 * authority, for as long as the call itself may take: a registry that is
 * unavailable for longer than a fixed five seconds used to refuse calls whose
 * own deadline had most of its time left
 * (docs/design/viewer-stalls-root-cause.md, section 4.3).
 * Each attempt resolves the capability again; no identity is cached. */
export async function identifyCallerWhenReady(resolve: () => string | null, capability: string | undefined,
  deadlineAt: number, signal: AbortSignal): Promise<string | null> {
  let reportedWaiting = false;
  try {
    signal.throwIfAborted();
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error("caller identification deadline expired");
    const waitMs = Math.max(1, remainingMs - CALLER_IDENTIFICATION_REPLY_RESERVE_MS);
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
