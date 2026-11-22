import { stripVTControlCharacters } from "node:util";

import { redactBounded } from "@/lib/monitor/redact";
import { ForgeAppWriteRefused } from "./appWrite";

type ReadFailureCause = "gh-not-found" | "app-refused" | "not-found" | "timed-out" | "rate-limited"
  | "unauthenticated" | "invalid-response" | "dns" | "certificate" | "network" | "command-error";

function readFailureEvidence(error: unknown) {
  const detail = error as { stderr?: unknown; message?: unknown; code?: unknown; killed?: unknown; signal?: unknown; timeoutMs?: unknown } | null;
  const stderr = typeof detail?.stderr === "string" ? detail.stderr : "";
  const message = typeof detail?.message === "string" ? detail.message : typeof error === "string" ? error : "";
  // The helper wraps installation HTTP/network failures in the same refusal
  // as unavailable credentials. Classify only its verification cause, keeping
  // repository names and the credential guidance out of the diagnostic.
  const installationFailure = error instanceof ForgeAppWriteRefused
    ? /^Delegatus refused this GitHub write(?: to [^:\s]+)?: (GitHub answered HTTP \d{3}(?: \(rate limited\))? while verifying the App installation|GitHub could not be reached to verify the App installation)\. /.exec(message)?.[1]
    : undefined;
  // execFile's message repeats argv before stderr. Only diagnostics classify
  // the failure; neither a command wrapper nor a URL path supplies evidence.
  const diagnostics = stripVTControlCharacters(installationFailure || stderr || message).split(/[\r\n\u2028\u2029]+/)
    .filter(part => !/^Command failed\b/i.test(part.trim()))
    .map(part => part.replace(/^gh:\s*/, "").trim()).filter(Boolean);
  const line = diagnostics[0] ?? "no diagnostic returned";
  // CLI option names can contain arbitrary text, including transport words.
  const unknownSwitch = /^unknown (flag|option)(?=[:\s]|$)/i.exec(line)?.[1]?.toLowerCase();
  const raw = unknownSwitch ? `unknown ${unknownSwitch}` : diagnostics.join("\n").replace(/https?:\/\/[^\s)]+/gi, "");
  const status = /\bHTTP(?:\/\d+(?:\.\d+)?)?[ :]+(\d{3})\b/i.exec(raw)?.[1];
  const transport = `${detail?.code ?? ""}\n${raw}`;
  return {
    detail, line, installationFailure, unknownSwitch,
    missingCli: detail?.code === "ENOENT",
    appRefused: error instanceof ForgeAppWriteRefused && !installationFailure,
    certificateFailure: /failed to verify certificate|certificate verify failed|x509:/i.test(raw),
    dnsFailure: /\bno such host\b/i.test(raw),
    resourceNotFound: status === "404" || (!status && /could not resolve to a (?:repository|pullrequest)\b/i.test(raw)),
    timedOut: detail?.code === "ETIMEDOUT" || (detail?.killed === true && (detail.signal === "SIGTERM" || detail.signal === "SIGKILL"))
      || (!status && /timed?\s*out|timeout|deadline exceeded/i.test(raw)),
    rateLimited: status === "429" || /rate.?limit|secondary rate|abuse detection/i.test(raw),
    proxyFailure: /proxy|connect tunnel|connect response|http connect/i.test(raw)
      && /proxy authentication required|407|unexpected eof|connection closed/i.test(raw),
    unauthenticated: status === "401" || status === "403" || (!status && (detail?.code === 4
      || /authentication|bad credentials|not logged|not signed|gh auth login|requires? auth|resource not accessible/i.test(raw))),
    plainNotFound: !status && /not found/i.test(raw),
    invalidResponse: error instanceof SyntaxError || /parsable|parse|malformed|invalid.*(?:json|response)|unexpected.*(?:json|token)|returned no /i.test(raw),
    transientTransport: status?.startsWith("5") === true
      || /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|network|socket hang up|TLS handshake|connection|service unavailable|could not resolve host|could not be reached/i.test(transport),
    unreachableNetwork: /\bENETUNREACH\b/i.test(transport),
  };
}

type ReadFailureEvidence = ReturnType<typeof readFailureEvidence>;

function mergeReadIsTransient(evidence: ReadFailureEvidence): boolean {
  if (evidence.missingCli || evidence.appRefused || evidence.certificateFailure || evidence.dnsFailure
    || evidence.resourceNotFound || evidence.unknownSwitch) return false;
  // A secondary rate limit can use HTTP 403. Keep the established outage
  // cases eligible and refuse explicit read errors ahead of generic transport text.
  if (evidence.timedOut || evidence.rateLimited) return true;
  if (evidence.proxyFailure || evidence.unauthenticated || evidence.plainNotFound || evidence.invalidResponse) return false;
  return evidence.transientTransport;
}

/** Apply the merge outage policy independently of optional read diagnostics. */
export function isTransientMergeReadFailure(error: unknown): boolean {
  return mergeReadIsTransient(readFailureEvidence(error));
}

function classifyGithubReadFailure(evidence: ReadFailureEvidence) {
  const { detail, line, installationFailure } = evidence;
  const failure = (cause: ReadFailureCause, label: string, excerpt = "") => ({
    cause, reason: () => redactBounded(`${label}: ${excerpt || "details withheld for privacy"}`, 400),
  });
  if (evidence.missingCli) return failure("gh-not-found", "GitHub CLI (gh) not found", "check the Viewer service PATH");
  if (evidence.appRefused) return failure("app-refused", "GitHub App read refused");
  if (installationFailure) {
    const safe = /GitHub (?:answered HTTP \d{3}(?: \(rate limited\))? while verifying the App installation|could not be reached to verify the App installation)/.exec(installationFailure)?.[0];
    if (safe) {
      const category: ReadFailureCause = /HTTP 429|rate limited/i.test(safe) ? "rate-limited"
        : /HTTP 5\d\d|could not be reached/i.test(safe) ? "network"
          : /HTTP 404/.test(safe) ? "not-found" : /HTTP 401|HTTP 403/.test(safe) ? "unauthenticated" : "command-error";
      const label = category === "rate-limited" ? "GitHub read rate limited"
        : category === "network" ? "GitHub read temporarily unavailable"
          : category === "not-found" ? "GitHub read not found"
            : category === "unauthenticated" ? "GitHub read authentication failed" : "GitHub App read refused";
      return failure(category, label, safe);
    }
  }
  if (evidence.certificateFailure) {
    return failure("certificate", "GitHub TLS certificate verification failed");
  }
  if (evidence.dnsFailure) return failure("dns", "GitHub DNS lookup failed");
  if (evidence.resourceNotFound) return failure("not-found", "GitHub read not found");
  if (evidence.timedOut) {
    const limit = typeof detail?.timeoutMs === "number" && Number.isFinite(detail.timeoutMs) && detail.timeoutMs > 0
      ? `limit ${detail.timeoutMs} ms;` : "";
    return failure("timed-out", "GitHub read timed out", limit);
  }
  if (evidence.rateLimited) return failure("rate-limited", "GitHub read rate limited");
  if (evidence.proxyFailure) return failure("network", "GitHub network request failed");
  if (evidence.unauthenticated) return failure("unauthenticated", "GitHub read authentication failed");
  if (evidence.plainNotFound) return failure("not-found", "GitHub read not found");
  if (evidence.invalidResponse) return failure("invalid-response", "GitHub read invalid response");
  if (evidence.transientTransport || evidence.unreachableNetwork) return failure("network", "GitHub read temporarily unavailable");
  const code = typeof detail?.code === "number" ? ` (exit ${detail.code})`
    : typeof detail?.code === "string" && /^[A-Z][A-Z_]+$/.test(detail.code) ? ` (${detail.code})` : "";
  // Preserve only known CLI phrases; arbitrary stderr can contain identities,
  // repository names, and paths that the general monitor redactor misses.
  const { unknownSwitch } = evidence;
  const safeExcerpt = unknownSwitch ? `unknown ${unknownSwitch}`
    : /^CLI invocation refused$/i.test(line) ? "CLI invocation refused" : "details withheld for privacy";
  return failure("command-error", `GitHub read failed${code}`, safeExcerpt);
}

/** Read failures carry no evidence that authorizes a GitHub write. */
export function githubReadFailure(error: unknown): { reason: string; transient: boolean } {
  const evidence = readFailureEvidence(error);
  return { reason: classifyGithubReadFailure(evidence).reason(), transient: mergeReadIsTransient(evidence) };
}

/** Actionable diagnostics for optional Viewer reads. Only command errors need stderr. */
export function githubReadDiagnostic(error: unknown): { cause: ReadFailureCause; message: string } {
  const { cause, reason } = classifyGithubReadFailure(readFailureEvidence(error));
  if (cause === "command-error") return { cause, message: `${reason()}. Check the gh installation and configuration, then retry.` };
  const messages: Record<Exclude<ReadFailureCause, "command-error">, string> = {
    "gh-not-found": "GitHub CLI (gh) not found on PATH. Install gh or add it to the Viewer service PATH.",
    "unauthenticated": "GitHub authentication failed. Run `gh auth login` with the Viewer's GH_CONFIG_DIR or check the configured GitHub App credentials.",
    dns: "GitHub DNS lookup failed. Check DNS and proxy settings, then retry.",
    certificate: "GitHub TLS certificate verification failed. Check the system trust store and proxy certificate configuration, then retry.",
    network: "GitHub network request failed. Check connectivity, DNS and proxy settings, then retry.",
    "app-refused": "GitHub App read refused. Check the App installation and credentials for this repository.",
    "not-found": "GitHub repository data was not found. Check the remote and repository access.",
    "timed-out": "GitHub read timed out. Check connectivity and retry.",
    "rate-limited": "GitHub read rate limited. Wait for the limit to reset and retry.",
    "invalid-response": "GitHub read returned an invalid response. Check the gh version and retry.",
  };
  return { cause, message: messages[cause] };
}

/** Durable failure counts yield the same paced retry after a restart. */
export function githubReadBackoff(failures: number): number {
  return Math.min(10 * 60_000, 60_000 * 2 ** Math.min(4, Math.max(0, failures - 1)));
}
