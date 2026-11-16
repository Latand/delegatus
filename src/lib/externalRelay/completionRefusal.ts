import { ExternalRelayError } from "./errors";

export type CompletionRefusal = { status: number; code: string; reason: string };

// Service errors can echo prompts, credentials or parser input. Persist only
// protocol vocabulary; never copy a free-form message or response body.
const codes = new Set([
  "invalid_format", "attachment_not_ready", "malformed", "invalid_answer",
  "lease_lost", "already_completed", "handoff_after_action", "unauthorized",
  "unsupported_version", "unknown_feature", "unsupported_feature", "not_found",
  "too_large", "rate_limited", "unreachable", "internal_error", "server_error",
  "unsupported_media_type", "attachment_conflict",
]);
const reasons = new Set([...codes, "answer_too_long", "rich_limit_exceeded", "plain_limit_exceeded", "unsupported_format"]);

export function completionRefusal(error: ExternalRelayError, status = error.status): CompletionRefusal {
  const payload = error.payload as { error?: { reason?: unknown } | { reason?: unknown }[] } | null;
  const wire = Array.isArray(payload?.error) ? payload.error[0] : payload?.error;
  const code = codes.has(error.code) ? error.code : "unrecognized_service_code";
  const reason = typeof wire?.reason === "string" && reasons.has(wire.reason) ? wire.reason
    : wire?.reason !== undefined ? "redacted_service_reason" : code;
  return { status: Number.isInteger(status) && status >= 300 && status <= 599 ? status : 0, code, reason };
}

export const ANSWER_TOO_LONG_NOTICE = "The answer was too long to deliver after the service refused its original format. Please request a shorter answer.";

export function answerTooLongNotice(plainMax: number): string | null {
  return [ANSWER_TOO_LONG_NOTICE, "Answer too long to deliver.", "Too long."].find(text => text.length <= plainMax) ?? null;
}
