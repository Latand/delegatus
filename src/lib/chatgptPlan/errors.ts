import { object } from "./constants";
import type { PlanFallback, PlanReason } from "./public";

const responses = {
  subscription_sharing_usage_limit_exceeded: "plan_limit",
  subscription_sharing_usage_unavailable: "retry_later",
  subscription_sharing_user_unavailable: "retry_later",
  subscription_sharing_user_not_eligible: "not_eligible",
  subscription_sharing_unsupported_capability: "request_invalid",
  subscription_sharing_route_not_supported: "policy_denied",
  chatpass_v2_scope_not_authorized: "policy_denied",
  chatpass_v2_invalid_authorization_context: "policy_denied",
  subscription_sharing_invalid_user: "credential_rejected",
} as const satisfies Record<string, PlanFallback>;

export const unusableRefresh = new Set([
  "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused",
]);

export class PlanError extends Error {
  constructor(readonly reason: PlanReason) { super(reason); }
}

const diagnostic = (value: unknown, accessToken: string): string | undefined =>
  typeof value === "string" && !value.includes(accessToken) && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : undefined;

export function responseError(status: number, body: unknown, requestId: string | null, accessToken: string): PlanError {
  const envelope = object(body);
  const error = object(envelope?.error) ?? envelope;
  const code = typeof error?.code === "string" && Object.hasOwn(responses, error.code)
    ? error.code as keyof typeof responses : undefined;
  const reason = code ? responses[code]
    : status === 401 ? "credential_rejected" : status === 403 ? "policy_denied"
      : status === 429 ? "plan_limit" : status >= 500 ? "retry_later" : "interrupted";
  // Log the envelope class and fixed code, never upstream message or input.
  console.info("[chatgpt-plan] responses", status, typeof envelope?.detail === "string" ? "admission" : "response",
    code, reason === "request_invalid" ? diagnostic(error?.param, accessToken) : undefined, diagnostic(requestId, accessToken));
  return new PlanError(reason);
}

export function fallbackReason(error: unknown): PlanFallback {
  const reason = error instanceof PlanError ? error.reason : "interrupted";
  switch (reason) {
    case "plan_limit": case "retry_later": case "not_eligible": case "request_invalid":
    case "policy_denied": case "credential_rejected": case "reconnect_required":
    case "not_connected": case "plan_disabled": return reason;
    default: return "interrupted";
  }
}
