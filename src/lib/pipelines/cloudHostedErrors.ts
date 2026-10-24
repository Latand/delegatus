export type HostedCloudFailure = "unavailable" | "cloud-limit" | "account-limit" | "invalid";

/** Keep provider bodies, headers and credentials inside the transport. */
export class HostedCloudError extends Error {
  constructor(message: string, readonly category: HostedCloudFailure) { super(message); }
}

export function hostedRpcFailure(error: { code?: unknown; message?: unknown; data?: { code?: unknown; codexErrorInfo?: unknown } }): HostedCloudError {
  const info = error.data?.codexErrorInfo;
  const code = String(error.data?.code ?? (info && typeof info === "object" && Object.keys(info).length === 1 ? Object.keys(info)[0] : info) ?? error.code);
  const category = ["usageLimitExceeded", "rateLimitExceeded", "accountLimitExceeded", "insufficientQuota", "sessionBudgetExceeded", "unauthorized"].includes(code) ? "account-limit"
    : ["cloudCapacityExceeded", "environmentTimeLimitExceeded", "environmentUnavailable", "serverOverloaded"].includes(code) ? "cloud-limit"
    : "invalid";
  return new HostedCloudError("Codex Cloud RPC refused", category);
}

export function hostedHttpFailure(status: number): HostedCloudError {
  return new HostedCloudError("Codex Cloud handshake refused",
    [401, 403, 429].includes(status) ? "account-limit"
      : [500, 502, 503, 504].includes(status) ? "unavailable" : "invalid");
}
