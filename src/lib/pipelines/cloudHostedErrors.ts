import { redactBounded } from "@/lib/monitor/redact";

export type HostedCloudFailure = "unavailable" | "cloud-limit" | "account-limit" | "invalid";

/** Keep provider bodies, headers and credentials inside the transport.
 * `diagnostic` marks a message this module already scrubbed for the record. */
export class HostedCloudError extends Error {
  constructor(message: string, readonly category: HostedCloudFailure, readonly diagnostic = false) { super(message); }
}

/** How a provider refusal reads: a known limit, a proven error in the stage's
 * own configuration, or an unknown cause that proves nothing about the stage. */
export type HostedRefusalKind = "account-limit" | "cloud-limit" | "configuration" | "unknown";
export class HostedRpcRefusal extends HostedCloudError {
  constructor(message: string, category: HostedCloudFailure, readonly refusal: HostedRefusalKind) { super(message, category, true); }
}

type Secrets = readonly (string | undefined)[];
/** Remove the session's own credentials, URLs, header values and quoted
 * credential assignments as well as the shared redactor's token families. */
export function scrubCloudText(value: string, secrets: Secrets, limit: number): string {
  let clean = value;
  for (const secret of secrets) if (secret) {
    for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      clean = clean.replaceAll(form, "[redacted]");
    }
  }
  clean = clean.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._=-]+/gi, "[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted-url]")
    .replace(/(["']?[\w.-]*(?:api[_-]?key|token|authorization|cookie|secret|password|passwd|pwd)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}]+)/gi, "$1[redacted]");
  return redactBounded(clean, limit).replace(/\p{Cc}+/gu, " ").trim();
}

/** Only the prose before a payload or header block is a diagnostic. An opening
 * markup delimiter also ends it, even in truncated HTML/XML. Discard that block
 * and everything after it, including folded headers and plain-text bodies.
 * Do this before flattening lines or selecting a bounded stderr tail,
 * which would lose the boundary and make payload bytes look like prose. */
export function cloudDiagnosticText(value: unknown, secrets: Secrets, limit: number): string {
  if (typeof value !== "string") return "";
  const boundary = value.search(/[\[{<]|\bHTTP\/\d(?:\.\d)?\b|\bheaders?\s*[:=]|(?:^|[\r\n]|[:;,])[ \t]*(?!(?:fatal|error|warning|hint)\s*:)[\w!#$%&'*+.^`|~-]+\s*:/im);
  const prose = (boundary < 0 ? value : value.slice(0, boundary)).trimEnd().replace(/[:;,]\s*$/, "");
  return scrubCloudText(prose, secrets, limit);
}

const ACCOUNT_LIMIT_CODES = ["usageLimitExceeded", "rateLimitExceeded", "accountLimitExceeded", "insufficientQuota", "sessionBudgetExceeded", "unauthorized"];
const CLOUD_LIMIT_CODES = ["cloudCapacityExceeded", "environmentTimeLimitExceeded", "environmentUnavailable", "serverOverloaded"];
// Only thread/start carries the stage's own model, effort and environment, so
// only its bad-request refusal proves a stage configuration error.
const CONFIGURATION_CODES: Record<string, string[]> = { "thread/start": ["badRequest"] };

export function hostedRpcFailure(error: { code?: unknown; message?: unknown; data?: { code?: unknown; codexErrorInfo?: unknown } },
  context: { method?: string; secrets?: Secrets } = {}): HostedRpcRefusal {
  const info = error.data?.codexErrorInfo;
  const raw = error.data?.code ?? (info && typeof info === "object" && Object.keys(info).length === 1 ? Object.keys(info)[0] : info) ?? error.code;
  const code = raw === undefined || raw === null ? "" : String(raw);
  const refusal: HostedRefusalKind = ACCOUNT_LIMIT_CODES.includes(code) ? "account-limit"
    : CLOUD_LIMIT_CODES.includes(code) ? "cloud-limit"
    : context.method && CONFIGURATION_CODES[context.method]?.includes(code) ? "configuration"
    : "unknown";
  const category = refusal === "account-limit" || refusal === "cloud-limit" ? refusal : "invalid";
  // Codes and the method name are recorded only in a plain identifier form.
  const plain = (value: string) => /^-?[A-Za-z0-9_./-]{1,80}$/.test(value) && scrubCloudText(value, context.secrets ?? [], 80) === value;
  const rpc = typeof error.code === "number" && Number.isSafeInteger(error.code) ? String(error.code) : "";
  const summary = [context.method && plain(context.method) ? context.method : "",
    `code ${!code ? "none" : plain(code) ? code : "unrecognised"}`, rpc && rpc !== code ? `rpc ${rpc}` : "", `category ${refusal}`].filter(Boolean).join(", ");
  const message = cloudDiagnosticText(error.message, context.secrets ?? [], 600);
  return new HostedRpcRefusal(`Codex Cloud RPC refused (${summary})${message ? `: ${message}` : ""}`, category, refusal);
}

/** A non-zero exit of the pre-model lane branch fetch/checkout. The provider
 * accepted the command, so this is a Cloud preparation failure. */
export function hostedPreparationFailure(exitCode: unknown, stderr: unknown, secrets: Secrets): HostedCloudError {
  const exit = Number.isSafeInteger(exitCode) ? String(exitCode) : "unknown";
  // Keep payload boundaries and scrub credentials before cutting the tail.
  const scrubbed = cloudDiagnosticText(stderr, secrets, 65_536);
  const tail = scrubbed.length > 400 ? scrubbed.slice(-400).replace(/^\S*\s*/, "") : scrubbed;
  return new HostedCloudError(`Codex Cloud lane branch preparation failed (exit ${exit}, category preparation)${tail ? `: ${tail}` : ""}`, "cloud-limit", true);
}

export function hostedHttpFailure(status: number): HostedCloudError {
  return new HostedCloudError("Codex Cloud handshake refused",
    [401, 403, 429].includes(status) ? "account-limit"
      : [500, 502, 503, 504].includes(status) ? "unavailable" : "invalid");
}

/** A positive transport cause is required for retry. TLS, malformed payloads,
 * redirects, unknown failures and explicit refusals remain decisive. */
export function hostedNetworkFailure(error: unknown): HostedCloudError {
  if (error instanceof HostedCloudError) return error;
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error) && seen.size < 8) {
    seen.add(error);
    const cause = error as { code?: unknown; cause?: unknown };
    if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE",
      "ConnectionClosed", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(String(cause.code))) {
      return new HostedCloudError("Codex Cloud catalogue transport unavailable", "unavailable");
    }
    error = cause.cause;
  }
  return new HostedCloudError("Codex Cloud catalogue refused", "invalid");
}
