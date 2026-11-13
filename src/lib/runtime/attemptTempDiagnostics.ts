/** A partial safety observation is deferred, never permission to remove. */
export class AttemptTempBudgetDeferred extends Error {
  constructor(reason = "checkout link inventory exceeded its tick budget") { super(`attempt temp deferred: ${reason}`); }
}

/** Keep child-command failures useful even when stderr is empty (timeouts,
 * signals and output bounds). Bound each diagnostic before it reaches a log. */
export function attemptTempFailureDetail(error: unknown, depth = 0): string {
  if (depth >= 3) return "cause depth limit";
  if (!error || typeof error !== "object") return String(error).slice(0, 2048);
  const value = error as { name?: string; message?: string; code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown; cause?: unknown };
  // execFile puts the entire command in message. Reserve the beginning of
  // the retained 1 KiB failure for the status and the actual error output.
  return [
    value.code !== undefined ? `code=${String(value.code)}` : "",
    value.signal !== undefined ? `signal=${String(value.signal)}` : "", value.killed ? "killed=true" : "",
    value.stderr !== undefined ? `stderr=${String(value.stderr).trim().slice(0, 512) || "(empty)"}` : "",
    value.cause ? `cause=${attemptTempFailureDetail(value.cause, depth + 1).slice(0, 768)}` : "",
    value.message || value.name || "unknown error"].filter(Boolean).join("; ").slice(0, 2048);
}
