/** A partial safety observation is deferred, never permission to remove. */
export class AttemptTempBudgetDeferred extends Error {
  constructor(reason = "checkout link inventory exceeded its tick budget") { super(`attempt temp deferred: ${reason}`); }
}

/** The generic trash sweeper returns error strings. Decode our diagnostic prefix
 * here so its callers and direct root visits report the same stable codes. */
export function attemptTempDeferralCode(detail: string, deadline: "tick_budget" | "root_budget") {
  const reason = detail.split("attempt temp deferred: ").at(-1) ?? detail;
  if (reason.startsWith("attempt protection inventory checkpointed")) return "protection_checkpoint";
  if (reason.startsWith("attempt protection marker budget")) return "protection_marker_limit";
  if (/^attempt protection (snapshot budget|inventory (changed|invalidated))/.test(reason))
    return reason.startsWith("attempt protection snapshot") ? "protection_budget" : "protection_changed";
  if (reason.startsWith("checkout link inventory exceeded")) return "checkout_budget";
  if (reason.startsWith("checkout changed")) return "checkout_changed";
  if (/^(?:attempt mutation fence|attempt permission repair|attempt namespace|namespace).*budget/.test(reason)
    || reason.startsWith("tick deadline leaves no bounded namespace")) {
    if (reason.includes("mutation fence")) return "mutation_fence_budget";
    if (reason.includes("permission repair")) return "permission_budget";
    return "namespace_budget";
  }
  if (reason.startsWith("attempt measurement")) return "allocation_budget";
  if (reason.startsWith("mount boundary")) return "mount_boundary";
  if (reason.startsWith("run budget")) return "tick_budget";
  if (reason.startsWith("tick deadline")) return deadline;
  if (reason.includes("unavailable")) return "proof_unavailable";
  return "proof_changed";
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
