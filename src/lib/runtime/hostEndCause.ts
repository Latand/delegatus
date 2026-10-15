/** Why a structured host ended (#2790). The first cause recorded wins, so a
    stop Delegatus started is never retold as the exit it caused. `reason` is
    Delegatus's own wording, never engine output. */
export interface HostEndCause {
  kind: "host-fault" | "child-exit" | "memory-kill";
  reason: string;
  code: number | null;
  signal: string | null;
  /** Whether Delegatus had already signalled the child when it ended. */
  signalledByHost: boolean;
  at: string;
}

export const HOST_END_REASON_MAX_CHARS = 200;
export const CLAUDE_CHILD_EXITED = "Claude child exited";

export function normalizeHostEndCause(value: unknown): HostEndCause | null {
  if (!value || typeof value !== "object") return null;
  const cause = value as Partial<HostEndCause>;
  if (cause.kind !== "host-fault" && cause.kind !== "child-exit" && cause.kind !== "memory-kill") return null;
  if (typeof cause.reason !== "string" || typeof cause.at !== "string" || !Number.isFinite(Date.parse(cause.at))) return null;
  if (cause.code !== null && !Number.isSafeInteger(cause.code)) return null;
  if (cause.signal !== null && typeof cause.signal !== "string") return null;
  if (typeof cause.signalledByHost !== "boolean") return null;
  return {
    kind: cause.kind,
    reason: Array.from(cause.reason).slice(0, HOST_END_REASON_MAX_CHARS).join(""),
    code: cause.code ?? null,
    signal: cause.signal ?? null,
    signalledByHost: cause.signalledByHost,
    at: cause.at,
  };
}

/** One clause naming how a Claude host ended, for its pending work, its
    lane and its log. */
export function claudeHostEndText(cause: HostEndCause): string {
  if (cause.kind === "memory-kill") return cause.reason;
  if (cause.kind === "host-fault") return `Delegatus stopped Claude: ${cause.reason}`;
  if (cause.reason !== CLAUDE_CHILD_EXITED) return cause.reason;
  if (cause.code !== null) return `${CLAUDE_CHILD_EXITED} with code ${cause.code}`;
  if (cause.signal !== null) {
    return cause.signalledByHost
      ? `${CLAUDE_CHILD_EXITED} on ${cause.signal} after Delegatus began stopping it`
      : `${CLAUDE_CHILD_EXITED} on ${cause.signal}, which Delegatus did not send`;
  }
  return CLAUDE_CHILD_EXITED;
}
