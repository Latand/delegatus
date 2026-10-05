import type { TFunction } from "@/lib/i18n";

export type LinkSeverity = "ok" | "warning" | "blocking" | "error";

const BLOCKING = ["needs-access-key", "needs-remote-entry", "http-public", "open-to-internet", "host-rewritten", "tls-failure", "invalid-address"];
const REQUEST_ERRORS = ["save-conflict", "key-failed", "unavailable"];

/** Every code the address line can draw. Anything else is not a check state. */
export function isDrawnState(code: string | null | undefined): code is string {
  return code === "ok" || code === "unverified" || BLOCKING.includes(code ?? "") || REQUEST_ERRORS.includes(code ?? "");
}

export type HostSeen = { host: string | null; forwardedHost: string | null; forwardedProto: string | null; forwarded: string | null };

/** What a failed Host check recorded, when the saved check carries all of it. */
export function hostSeen(check: { code: string; expected?: unknown; seen?: unknown } | null | undefined): { expected: string; seen: HostSeen } | null {
  if (check?.code !== "host-rewritten" || typeof check.expected !== "string" || typeof check.seen !== "object" || check.seen === null) return null;
  const read = (key: keyof HostSeen) => { const value = (check.seen as Record<string, unknown>)[key]; return typeof value === "string" ? value : null; };
  return { expected: check.expected, seen: { host: read("host"), forwardedHost: read("forwardedHost"), forwardedProto: read("forwardedProto"), forwarded: read("forwarded") } };
}

/** Whether X-Forwarded-Host still carries the name the Host lost. */
export function forwardedNamesAddress(expected: string, forwardedHost: string | null): boolean {
  const name = (value: string) => value.trim().toLowerCase().replace(/:\d+$/, "");
  return forwardedHost !== null && name(forwardedHost.split(",")[0]!) === name(expected);
}

/** How a check state reads. An unverified address only blocks linking when the
    local entry vouches for loopback callers (`localVouches`), which is the
    condition `mintCode` refuses it under; otherwise it is a warning. */
export function linkSeverity(code: string, localVouches: boolean | undefined): LinkSeverity {
  if (code === "ok") return "ok";
  if (code === "unverified") return localVouches === false ? "warning" : "blocking";
  if (BLOCKING.includes(code)) return "blocking";
  return "error";
}

/** The sentence for a failed connect. An unknown code is named, never swallowed. */
export function connectErrorMessage(t: TFunction, error: string): string {
  switch (error) {
    case "invalid-code": return t("links.error.invalidCode");
    case "peer-open": return t("links.error.peerOpen");
    case "unreachable": return t("links.error.unreachable");
    case "version": return t("links.error.version");
    case "not-delegatus": return t("links.error.notDelegatus");
    case "already-linked": return t("links.error.alreadyLinked");
    case "code-spent": return t("links.error.codeSpent");
    case "rate-limited": return t("links.error.rateLimited");
    case "revoked": return t("links.error.revoked");
    case "store-changed": return t("links.error.storeChanged");
    case "grant-cleanup-needed": return t("links.error.grantCleanupNeeded");
    case "unauthorized": return t("links.error.unauthorized");
    case "http-public": return t("links.error.peerHttp");
    case "invalid-address": return t("links.error.peerAddress");
    case "owner-required": return t("links.error.ownerOnly");
    case "staging": return t("links.error.staging");
    case "unavailable": return t("links.state.unavailable");
    default: return t("links.error.other", { reason: error });
  }
}

const REQUEST_ANSWERS = ["owner-required", "staging", "revoked", "store-changed", "grant-cleanup-needed", "unauthorized"];

/** The sentence for a failed peer, grant, share or code action. A code the
    dialog has no sentence for reads as the generic "could not answer". */
export function requestErrorMessage(t: TFunction, error: string): string {
  if (error === "cannot-share") return t("links.cannotShare");
  return REQUEST_ANSWERS.includes(error) ? connectErrorMessage(t, error) : t("links.state.unavailable");
}

/** The sentence under a peer row. The raw code never stands alone. */
export function peerErrorMessage(t: TFunction, error: string, name: string): string {
  switch (error) {
    case "revoked": return t("links.error.revoked");
    case "malformed":
    case "not-delegatus":
    case "version": return t("links.peerError.version", { name });
    case "unreachable": return t("links.peerError.unreachable", { name });
    case "clock": return t("links.peerError.clock", { name });
    case "quota": return t("links.peerError.quota", { name });
    default: return t("links.peerError.other", { reason: error });
  }
}
