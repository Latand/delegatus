import { relayResponseReason, type RelayHttpReason } from "./httpDiagnostics";
import { ExternalRelayError } from "./errors";

export const RELAY_POLL_PATH = "/requests/claim";
export const RELAY_POLL_SUMMARY_MS = 10 * 60_000;
const CHANGE_LIMIT = 30;
const CHANGE_WINDOW_MS = 60_000;
type ConnectionClass = "refused" | "timeout" | "dns" | "tls" | "reset" | "unreachable";
export type RelayPollOutcome = "ok-empty" | "claimed" | `http:${number}` | `connection:${ConnectionClass}` | "invalid-response" | "local-error";
export type RelayPollResult = { outcome: RelayPollOutcome; status: number | null; reason?: RelayHttpReason };
export type RelayPollCounters = { polls: number; empty: number; claimed: number; errors: Record<string, number> };

/** Only fixed classes and validated HTTP codes cross the journal/status boundary.
 * Unrecognized remote codes, exception messages and causes are never copied. */
export function relayPollFailure(error: unknown, responseStatus?: number): RelayPollResult {
  const status = responseStatus ?? (error instanceof ExternalRelayError ? error.status : 0);
  const http = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  if (http && http >= 300) return { outcome: `http:${http}`, status: http, reason: relayResponseReason(error instanceof ExternalRelayError ? error.payload : null) };
  if (error instanceof ExternalRelayError) {
    if (error.code === "dns_error") return { outcome: "connection:dns", status: http };
    if (error.code === "timeout") return { outcome: "connection:timeout", status: http };
    if (["malformed", "too_large"].includes(error.code)) return { outcome: "invalid-response", status: http };
  }
  const rawCode = error && typeof error === "object" && "code" in error ? error.code : null;
  const code = typeof rawCode === "string" ? rawCode : "";
  const name = error instanceof Error ? error.name : null;
  let kind: ConnectionClass | null = null;
  if (code === "ECONNREFUSED") kind = "refused";
  else if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ABORT_ERR"].includes(code) || name === "TimeoutError" || name === "AbortError") kind = "timeout";
  else if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) kind = "dns";
  else if (typeof code === "string" && /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?$)/.test(code)) kind = "tls";
  else if (["ECONNRESET", "EPIPE"].includes(code)) kind = "reset";
  else if (["ENETUNREACH", "EHOSTUNREACH"].includes(code) || error instanceof ExternalRelayError && error.code === "unreachable") kind = "unreachable";
  return { outcome: kind ? `connection:${kind}` : "local-error", status: http };
}

/** One owner per paired relay in the poller controller. Counters describe this
 * Viewer process; settings restarts retain them, process restarts start a new
 * timestamped session. Removal of the pairing evicts the owner. */
export class RelayPollDiagnostics {
  private readonly since: string;
  private summaryAt: number;
  private windowAt: number;
  private changes = 0;
  private suppressedChanges = 0;
  private last: (RelayPollResult & { at: string }) | null = null;
  private readonly counters: RelayPollCounters = { polls: 0, empty: 0, claimed: 0, errors: {} };

  constructor(now = Date.now()) {
    this.since = new Date(now).toISOString();
    this.summaryAt = this.windowAt = now;
  }
  snapshot() {
    return { path: RELAY_POLL_PATH, since: this.since, lastOutcome: this.last && { ...this.last },
      counters: { ...this.counters, errors: { ...this.counters.errors } }, suppressedChanges: this.suppressedChanges };
  }
  record(result: RelayPollResult, now = Date.now()): void {
    const changed = this.last?.outcome !== result.outcome || this.last.status !== result.status || this.last.reason !== result.reason;
    this.counters.polls++;
    if (result.outcome === "ok-empty") this.counters.empty++;
    else if (result.outcome === "claimed") this.counters.claimed++;
    else this.counters.errors[result.outcome] = (this.counters.errors[result.outcome] ?? 0) + 1;
    this.last = { ...result, at: new Date(now).toISOString() };
    if (now - this.windowAt >= CHANGE_WINDOW_MS) { this.windowAt = now; this.changes = 0; }
    if (changed) {
      if (this.changes < CHANGE_LIMIT) {
        this.changes++;
        console.info("External relay poll outcome", JSON.stringify({ path: RELAY_POLL_PATH, ...this.last }));
      } else this.suppressedChanges++;
    }
    this.summarize(now);
  }
  summarize(now = Date.now()): void {
    if (!this.counters.polls || now - this.summaryAt < RELAY_POLL_SUMMARY_MS) return;
    this.summaryAt = now;
    console.info("External relay poll summary", JSON.stringify({ ...this.snapshot(), at: new Date(now).toISOString() }));
  }
}
