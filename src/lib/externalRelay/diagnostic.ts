import { scrubOwnerOutput } from "./ownerOutput";

/** The first observed failure, retained independently of stop-control retries. */
export type OwnerTurnDiagnostic = {
  source: "exception" | "launch" | "observation" | "admission-deadline" | "hard-cap";
  message: string;
  status?: number;
  exitCode?: number | null;
  signal?: string | null;
  deadlineAt?: string;
  cutoffAt?: string;
  deadlineSource?: "deadline_at" | "receipt";
  deadlineFallback?: null | "absent" | "unparseable" | "past";
  rawDeadlineAt?: string | null;
  executionLimitMs?: number;
};

export function ownerTurnDiagnostic(source: OwnerTurnDiagnostic["source"], reason: unknown, credentials: readonly string[] = []): OwnerTurnDiagnostic {
  let message = "Owner turn failed without further details";
  try {
    if (reason instanceof Error) message = `${reason.name}: ${reason.message}`;
    else if (typeof reason === "string" && reason.trim()) message = reason;
    // Scrub before bounding: a cut credential or key must never become readable.
    message = scrubOwnerOutput(message, credentials);
  } catch { message = "Owner turn diagnostic unavailable"; }
  return { source, message: Array.from(message).slice(0, 1024).join("") };
}
