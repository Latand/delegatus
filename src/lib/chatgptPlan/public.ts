export const PLAN_USAGE_URL = "https://chatgpt.com/settings/usage";
export const CHATGPT_SETTINGS_URL = "https://chatgpt.com/settings";

export type PlanState = "off_staging" | "off_unconfigured" | "off_unsupported_platform" | "plan_limit" | "retry_later" | "not_connected" | "connecting" | "connected"
  | "plan_disabled" | "reconnect_required" | "remote_browser" | "error";

export type PlanFallback = "plan_limit" | "retry_later" | "not_eligible" | "request_invalid"
  | "policy_denied" | "credential_rejected" | "interrupted" | "reconnect_required"
  | "not_connected" | "plan_disabled";

export type PlanReason = PlanFallback | "declined" | "client_rejected" | "account_mismatch"
  | "registration_incomplete" | "credential_file" | "host_file" | "expired"
  | "busy" | "invalid_request" | "incomplete" | "stream_interrupted";

export type PlanStatus = {
  state: PlanState;
  reason?: PlanReason;
  account?: { email: string };
  planModels?: { voiceBackend: boolean };
  revocationConfirmed?: boolean;
  acknowledged?: boolean;
  usageUrl?: typeof PLAN_USAGE_URL;
  authorizeUrl?: string;
};

export type PlanBilling = { source: "plan" } | { source: "key"; reason: PlanFallback }
  | { source: "blocked"; reason: "policy_denied" | "not_eligible" };
