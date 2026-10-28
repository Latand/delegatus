import { redactBounded } from "@/lib/monitor/redact";
import { ForgeAppWriteRefused } from "./appWrite";

/** Read failures carry no evidence that authorizes a GitHub write. */
export function githubReadFailure(error: unknown): { reason: string; transient: boolean } {
  const detail = error as { stderr?: unknown; message?: unknown; code?: unknown; killed?: unknown; signal?: unknown } | null;
  const stderr = typeof detail?.stderr === "string" ? detail.stderr : "";
  const message = typeof detail?.message === "string" ? detail.message : typeof error === "string" ? error : "";
  const raw = `${stderr}\n${message}`;
  const line = (stderr || message).split(/\r?\n/).map(part => part.replace(/^gh:\s*/, "").trim())
    .find(part => part && !/^Command failed/.test(part)) ?? "no diagnostic returned";
  const reason = (label: string) => redactBounded(`${label}: ${line}`, 400);
  if (error instanceof ForgeAppWriteRefused) return { reason: reason("GitHub App read refused"), transient: false };
  if (detail?.code === "ETIMEDOUT" || (detail?.killed === true && (detail.signal === "SIGTERM" || detail.signal === "SIGKILL"))
    || /timed?\s*out|timeout|deadline exceeded/i.test(raw)) {
    return { reason: reason("GitHub read timed out"), transient: true };
  }
  // A secondary rate limit can use HTTP 403, so classify it before auth.
  if (/\b429\b|rate.?limit|secondary rate|abuse detection/i.test(raw)) return { reason: reason("GitHub read rate limited"), transient: true };
  if (detail?.code === 4 || /\b401\b|\b403\b|authentication|bad credentials|not logged|not signed|gh auth login|requires? auth|resource not accessible/i.test(raw)) {
    return { reason: reason("GitHub read authentication failed"), transient: false };
  }
  if (/\b404\b|not found|could not resolve to a repository|could not resolve to a pullrequest/i.test(raw)) return { reason: reason("GitHub read not found"), transient: false };
  if (error instanceof SyntaxError || /parsable|parse|malformed|invalid.*(?:json|response)|unexpected.*(?:json|token)|returned no /i.test(raw)) {
    return { reason: reason("GitHub read invalid response"), transient: false };
  }
  if (/\b5\d\d\b|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|network|socket hang up|TLS handshake|connection|service unavailable|could not resolve host/i.test(`${detail?.code ?? ""}\n${raw}`)) {
    return { reason: reason("GitHub read temporarily unavailable"), transient: true };
  }
  const code = typeof detail?.code === "number" ? ` (exit ${detail.code})` : "";
  return { reason: reason(`GitHub read failed${code}`), transient: false };
}

/** Durable failure counts yield the same paced retry after a restart. */
export function githubReadBackoff(failures: number): number {
  return Math.min(10 * 60_000, 60_000 * 2 ** Math.min(4, Math.max(0, failures - 1)));
}
