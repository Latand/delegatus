import { redactBounded } from "@/lib/monitor/redact";
import { ForgeAppWriteRefused } from "./appWrite";

/** Read failures carry no evidence that authorizes a GitHub write. */
export function githubReadFailure(error: unknown): { reason: string; transient: boolean } {
  const detail = error as { stderr?: unknown; message?: unknown; code?: unknown; killed?: unknown; signal?: unknown; timeoutMs?: unknown } | null;
  const stderr = typeof detail?.stderr === "string" ? detail.stderr : "";
  const message = typeof detail?.message === "string" ? detail.message : typeof error === "string" ? error : "";
  // execFile's message repeats argv before stderr. Only diagnostics classify
  // the failure; neither a command wrapper nor a URL path supplies evidence.
  const diagnostics = (stderr || message).split(/\r?\n/)
    .filter(part => !/^Command failed\b/i.test(part.trim()))
    .map(part => part.replace(/^gh:\s*/, "").trim()).filter(Boolean);
  const raw = diagnostics.join("\n").replace(/https?:\/\/[^\s)]+/gi, "");
  const line = diagnostics[0] ?? "no diagnostic returned";
  const status = /\bHTTP(?:\/\d+(?:\.\d+)?)?[ :]+(\d{3})\b/i.exec(raw)?.[1];
  const reason = (label: string) => redactBounded(`${label}: ${line}`, 400);
  if (error instanceof ForgeAppWriteRefused) return { reason: reason("GitHub App read refused"), transient: false };
  if (status === "404" || (!status && /could not resolve to a (?:repository|pullrequest)\b/i.test(raw))) return { reason: reason("GitHub read not found"), transient: false };
  if (detail?.code === "ETIMEDOUT" || (detail?.killed === true && (detail.signal === "SIGTERM" || detail.signal === "SIGKILL"))
    || (!status && /timed?\s*out|timeout|deadline exceeded/i.test(raw))) {
    const limit = typeof detail?.timeoutMs === "number" && Number.isFinite(detail.timeoutMs) && detail.timeoutMs > 0
      ? `limit ${detail.timeoutMs} ms; ` : "";
    return { reason: redactBounded(`GitHub read timed out: ${limit}${line}`, 400), transient: true };
  }
  // A secondary rate limit can use HTTP 403, so classify it before auth.
  if (status === "429" || /rate.?limit|secondary rate|abuse detection/i.test(raw)) return { reason: reason("GitHub read rate limited"), transient: true };
  if (status === "401" || status === "403" || (!status && (detail?.code === 4 || /authentication|bad credentials|not logged|not signed|gh auth login|requires? auth|resource not accessible/i.test(raw)))) {
    return { reason: reason("GitHub read authentication failed"), transient: false };
  }
  if (!status && /not found/i.test(raw)) return { reason: reason("GitHub read not found"), transient: false };
  if (error instanceof SyntaxError || /parsable|parse|malformed|invalid.*(?:json|response)|unexpected.*(?:json|token)|returned no /i.test(raw)) {
    return { reason: reason("GitHub read invalid response"), transient: false };
  }
  if (status?.startsWith("5") || /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|network|socket hang up|TLS handshake|connection|service unavailable|could not resolve host/i.test(`${detail?.code ?? ""}\n${raw}`)) {
    return { reason: reason("GitHub read temporarily unavailable"), transient: true };
  }
  const code = typeof detail?.code === "number" ? ` (exit ${detail.code})` : "";
  return { reason: reason(`GitHub read failed${code}`), transient: false };
}

/** Durable failure counts yield the same paced retry after a restart. */
export function githubReadBackoff(failures: number): number {
  return Math.min(10 * 60_000, 60_000 * 2 ** Math.min(4, Math.max(0, failures - 1)));
}
