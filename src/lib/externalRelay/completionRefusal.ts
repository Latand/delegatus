import { ExternalRelayError } from "./errors";

export type CompletionRefusal = { status: number; code: string; reason: string };

// Service errors can echo prompts, credentials or parser input. Persist only
// protocol vocabulary; never copy a free-form message or response body.
const codes = new Set([
  "invalid_format", "attachment_not_ready", "malformed", "invalid_answer",
  "lease_lost", "already_completed", "handoff_after_action", "unauthorized",
  "unsupported_version", "unknown_feature", "unsupported_feature", "not_found",
  "too_large", "rate_limited", "unreachable", "internal_error", "server_error",
  "unsupported_media_type", "unsupported_format", "attachment_conflict",
]);
const reasons = new Set([...codes, "answer_too_long", "rich_limit_exceeded", "plain_limit_exceeded", "unsupported_format"]);

function lengthReason(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 1024) return;
  if (!/\b(?:too|exceeds?|exceeded|limit|maximum)\b/i.test(value)
    || !/\b(?:long|large|length|size|characters?|limit|maximum|max_chars)\b/i.test(value)) return;
  if (/\b(?:rich(?:_markdown)?|markdown)\b/i.test(value)) return "rich_limit_exceeded";
  if (/\bplain\b/i.test(value)) return "plain_limit_exceeded";
  if (/\btoo (?:long|large)\b/i.test(value)) return "answer_too_long";
}

export function completionRefusal(error: ExternalRelayError, status = error.status): CompletionRefusal {
  const payload = error.payload as { error?: { reason?: unknown; message?: unknown } | { reason?: unknown; message?: unknown }[] } | null;
  const wire = Array.isArray(payload?.error) ? payload.error[0] : payload?.error;
  const code = codes.has(error.code) ? error.code : "unrecognized_service_code";
  const reason = typeof wire?.reason === "string" && reasons.has(wire.reason) ? wire.reason
    : lengthReason(wire?.reason) ?? lengthReason(wire?.message)
      ?? (wire?.reason !== undefined ? "redacted_service_reason" : code);
  return { status: Number.isInteger(status) && status >= 300 && status <= 599 ? status : 0, code, reason };
}

/** Shared sanitized refusal path for foreground completion and restart recovery. */
export function recordCompletionRefusal(error: ExternalRelayError, status: number, requestId: string,
  onRefusal?: (refusal: CompletionRefusal) => void): CompletionRefusal {
  const refusal = completionRefusal(error, status);
  console.error("External relay completion refused", { request: requestId.slice(0, 8), ...refusal });
  onRefusal?.(refusal);
  return refusal;
}

/** Writes a refusal event from the process that owns the durable request journal. */
export function journalCompletionRefusal(requestId: string, refusal: CompletionRefusal): void {
  console.info("External relay completion refusal", JSON.stringify({ event: "relay_completion_refused", requestId, ...refusal }));
}

export const ANSWER_TOO_LONG_NOTICE = "The answer was too long to deliver after the service refused its original format. Please request a shorter answer.";

export function answerTooLongNotice(plainMax: number): string | null {
  return [ANSWER_TOO_LONG_NOTICE, "Answer too long to deliver.", "Answer too long.", "Too long."].find(text => text.length <= plainMax) ?? null;
}
