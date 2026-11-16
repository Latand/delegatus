/** Fixed protocol vocabulary only. A syntactically valid remote string may
 * still be an identifier or credential, so regex validation alone is unsafe. */
const REASONS = ["lease_lost", "already_completed", "handoff_after_action", "malformed", "unauthorized",
  "unsupported_version", "invalid_format", "attachment_not_ready", "unknown_feature", "unknown_features",
  "unsupported_feature", "unsupported_features", "rate_limited", "not_found", "too_large", "invalid_request",
  "disabled", "busy", "no_capacity", "deadline_exceeded", "request_expired", "other"] as const;
export type RelayHttpReason = typeof REASONS[number];
export function safeRelayHttpReason(value: unknown): RelayHttpReason {
  return typeof value === "string" && (REASONS as readonly string[]).includes(value) ? value as RelayHttpReason : "other";
}
export function relayResponseReason(payload: unknown): RelayHttpReason {
  if (!payload || typeof payload !== "object") return "other";
  const body = payload as { error?: unknown; code?: unknown; reason?: unknown };
  const error = Array.isArray(body.error) ? body.error[0] : body.error;
  const detail = error && typeof error === "object" ? error as { code?: unknown; reason?: unknown } : null;
  return safeRelayHttpReason(detail?.code ?? detail?.reason ?? body.code ?? body.reason);
}
export type RelayHttpPath = "/requests/claim" | "/requests/:request/heartbeat" | "/requests/:request/complete";
export type RelayHttpRefusal = { path: RelayHttpPath; status: number; reason: RelayHttpReason };
export function relayHttpRefusal(route: string, status: number, payload: unknown): RelayHttpRefusal | null {
  if (!Number.isInteger(status) || status < 300 || status > 599) return null;
  const path: RelayHttpPath | null = route === "/requests/claim" ? route
    : /^\/requests\/[^/]+\/heartbeat$/.test(route) ? "/requests/:request/heartbeat"
      : /^\/requests\/[^/]+\/complete$/.test(route) ? "/requests/:request/complete" : null;
  return path ? { path, status, reason: relayResponseReason(payload) } : null;
}

type RefusalWindow = { at: number; changes: number; signature: string; loggedAt: number; suppressed: number };
const globalJournal = globalThis as typeof globalThis & { __llvRelayHttpRefusals?: Map<RelayHttpPath, RefusalWindow> };
const windows = globalJournal.__llvRelayHttpRefusals ??= new Map<RelayHttpPath, RefusalWindow>();
/** Three fixed keys bound memory. Repeated refusals log at most once per ten
 * minutes; flapping refusals log at most thirty times per minute per path. */
export function noteRelayHttpRefusal(input: RelayHttpRefusal, now = Date.now()): void {
  // Revalidate helper-process frames at the journal boundary as well.
  if (!["/requests/claim", "/requests/:request/heartbeat", "/requests/:request/complete"].includes(input.path)
    || !Number.isInteger(input.status) || input.status < 300 || input.status > 599) return;
  const record = { path: input.path, status: input.status, reason: safeRelayHttpReason(input.reason) };
  const signature = JSON.stringify(record);
  const window = windows.get(record.path) ?? { at: now, changes: 0, signature: "", loggedAt: now, suppressed: 0 };
  if (now - window.at >= 60_000) { window.at = now; window.changes = 0; }
  if ((window.signature !== signature || now - window.loggedAt >= 600_000) && window.changes < 30) {
    console.info("External relay HTTP refusal", JSON.stringify({ ...record, at: new Date(now).toISOString(), suppressed: window.suppressed }));
    window.signature = signature; window.loggedAt = now; window.changes++; window.suppressed = 0;
  } else window.suppressed++;
  windows.set(record.path, window);
}
