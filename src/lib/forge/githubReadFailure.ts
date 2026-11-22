import { stripVTControlCharacters } from "node:util";

import { redactBounded } from "@/lib/monitor/redact";
import { ForgeAppWriteRefused } from "./appWrite";

type ReadFailureCause = "gh-not-found" | "app-refused" | "not-found" | "timed-out" | "rate-limited"
  | "unauthenticated" | "invalid-response" | "network" | "command-error";

function classifyGithubReadFailure(error: unknown) {
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
  const raw = diagnostics.join("\n").replace(/https?:\/\/[^\s)]+/gi, "");
  const line = diagnostics[0] ?? "no diagnostic returned";
  const status = /\bHTTP(?:\/\d+(?:\.\d+)?)?[ :]+(\d{3})\b/i.exec(raw)?.[1];
  const failure = (cause: ReadFailureCause, label: string, transient = false, excerpt = line) => ({
    cause, transient, reason: () => redactBounded(`${label}: ${excerpt}`, 400),
  });
  if (detail?.code === "ENOENT") return failure("gh-not-found", "GitHub CLI (gh) not found", false, "check the Viewer service PATH");
  if (error instanceof ForgeAppWriteRefused && !installationFailure) return failure("app-refused", "GitHub App read refused");
  if (status === "404" || (!status && /could not resolve to a (?:repository|pullrequest)\b/i.test(raw))) return failure("not-found", "GitHub read not found");
  if (detail?.code === "ETIMEDOUT" || (detail?.killed === true && (detail.signal === "SIGTERM" || detail.signal === "SIGKILL"))
    || (!status && /timed?\s*out|timeout|deadline exceeded/i.test(raw))) {
    const limit = typeof detail?.timeoutMs === "number" && Number.isFinite(detail.timeoutMs) && detail.timeoutMs > 0
      ? `limit ${detail.timeoutMs} ms; ` : "";
    return failure("timed-out", "GitHub read timed out", true, `${limit}${line}`);
  }
  // A secondary rate limit can use HTTP 403, so classify it before auth.
  if (status === "429" || /rate.?limit|secondary rate|abuse detection/i.test(raw)) return failure("rate-limited", "GitHub read rate limited", true);
  if (status === "401" || status === "403" || (!status && (detail?.code === 4 || /authentication|bad credentials|not logged|not signed|gh auth login|requires? auth|resource not accessible/i.test(raw)))) {
    return failure("unauthenticated", "GitHub read authentication failed");
  }
  if (error instanceof SyntaxError || /parsable|parse|malformed|invalid.*(?:json|response)|unexpected.*(?:json|token)|returned no /i.test(raw)) {
    return failure("invalid-response", "GitHub read invalid response");
  }
  if (status?.startsWith("5") || /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ENOTFOUND|network|socket hang up|TLS handshake|connection|service unavailable|no such host|could not resolve host|could not be reached/i.test(`${detail?.code ?? ""}\n${raw}`)) {
    return failure("network", "GitHub read temporarily unavailable", true);
  }
  const code = typeof detail?.code === "number" ? ` (exit ${detail.code})`
    : typeof detail?.code === "string" && /^[A-Z][A-Z_]+$/.test(detail.code) ? ` (${detail.code})` : "";
  const excerpt = line.replace(/https?:\/\/[^\s)]+/gi, "[url]");
  return failure("command-error", `GitHub read failed${code}`, false, excerpt);
}

/** Read failures carry no evidence that authorizes a GitHub write. */
export function githubReadFailure(error: unknown): { reason: string; transient: boolean } {
  const { reason, transient } = classifyGithubReadFailure(error);
  return { reason: reason(), transient };
}

/** Actionable diagnostics for optional Viewer reads. Only command errors need stderr. */
export function githubReadDiagnostic(error: unknown): { cause: ReadFailureCause; message: string } {
  const { cause, reason } = classifyGithubReadFailure(error);
  if (cause === "command-error") return { cause, message: `${reason()}. Check the gh installation and configuration, then retry.` };
  const messages: Record<Exclude<ReadFailureCause, "command-error">, string> = {
    "gh-not-found": "GitHub CLI (gh) not found on PATH. Install gh or add it to the Viewer service PATH.",
    "unauthenticated": "GitHub authentication failed. Run `gh auth login` with the Viewer's GH_CONFIG_DIR or check the configured GitHub App credentials.",
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
