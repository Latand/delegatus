import { normalizeRuntimeDeliveryFailure, type RuntimeDeliveryFailure } from "@/lib/runtime/contracts";
import { scrubOwnerOutput } from "./ownerOutput";
import { RelayMandatoryPromptTooLargeError } from "./promptBudget";

/** The first observed failure, retained independently of stop-control retries. */
export type OwnerTurnDiagnostic = {
  source: "exception" | "launch" | "observation" | "admission-deadline" | "hard-cap";
  message: string;
  status?: number;
  /** The failure concerns delivery of an existing conversation continuation. */
  deliveryFailure?: true;
  primaryFailure?: RuntimeDeliveryFailure;
  exitCode?: number | null;
  signal?: string | null;
  deadlineAt?: string;
  cutoffAt?: string;
  deadlineSource?: "deadline_at" | "receipt";
  deadlineFallback?: null | "absent" | "unparseable" | "past";
  rawDeadlineAt?: string | null;
  executionLimitMs?: number;
  promptBudget?: { kind: "mandatory_core_too_large"; mandatoryBytes: number; limitBytes: number;
    priorAction?: "completed" | "unknown" | "confirmation_pending" | "confirmation_expired" };
};

export function ownerTurnDiagnostic(source: OwnerTurnDiagnostic["source"], reason: unknown, credentials: readonly string[] = [], primaryFailure?: RuntimeDeliveryFailure): OwnerTurnDiagnostic {
  let message = "Owner turn failed without further details";
  try {
    if (reason instanceof Error) message = `${reason.name}: ${reason.message}`;
    else if (typeof reason === "string" && reason.trim()) message = reason;
    // Scrub before bounding: a cut credential or key must never become readable.
    message = scrubOwnerOutput(message, credentials);
  } catch { message = "Owner turn diagnostic unavailable"; }
  let primary: RuntimeDeliveryFailure | undefined;
  try {
    primary = normalizeRuntimeDeliveryFailure(primaryFailure && { ...primaryFailure,
      reason: primaryFailure.reason === null ? null : scrubOwnerOutput(primaryFailure.reason, credentials) });
  } catch { /* The bounded message still retains the first failure. */ }
  return { source, message: Array.from(message).slice(0, 1024).join(""),
    ...(primary ? { primaryFailure: primary } : {}),
    ...(reason instanceof RelayMandatoryPromptTooLargeError ? { promptBudget: {
      kind: "mandatory_core_too_large" as const, mandatoryBytes: reason.mandatoryBytes, limitBytes: 32_000,
    } } : {}) };
}
